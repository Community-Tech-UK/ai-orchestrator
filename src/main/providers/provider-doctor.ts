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
import { checkClaudeCliAuthentication } from './claude-cli-auth';
import { checkCodexCliAuthentication } from './codex-cli-auth';
import { checkGeminiCliAuthentication } from './gemini-cli-auth';
import { CliDetectionService, type CliType, type CliShadowReport } from '../cli/cli-detection';

const logger = getLogger('ProviderDoctor');

export type ProbeStatus = 'pass' | 'fail' | 'skip' | 'timeout';

export interface ProbeResult {
  name: string;
  status: ProbeStatus;
  message: string;
  latencyMs: number;
  metadata?: Record<string, unknown>;
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
  overall: HealthStatus;
  recommendations: string[];
  timestamp: number;
}

const CRITICAL_PROBES = new Set(['cli_installed', 'sdk_available']);

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
        appliesTo: ['claude-cli', 'codex-cli', 'gemini-cli', 'copilot', 'cursor'],
        run: async (provider) => {
          if (provider === 'copilot') {
            const start = Date.now();
            const launch = resolveCopilotCliLaunch();
            return {
              name: 'cli_installed',
              status: launch ? 'pass' as const : 'fail' as const,
              message: launch
                ? `${launch.displayCommand} found in PATH`
                : 'Neither `copilot` nor `gh copilot` was found in PATH',
              latencyMs: Date.now() - start,
            };
          }

          const cliMap: Record<string, string> = {
            'claude-cli': 'claude',
            'codex-cli': 'codex',
            'gemini-cli': 'gemini',
            'cursor': 'cursor-agent',
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
            };
          }
        },
      },
      {
        name: 'cli_shadow_check',
        description: 'Check for stale or shadow CLI installs at multiple PATH locations',
        critical: false,
        appliesTo: ['claude-cli', 'codex-cli', 'gemini-cli', 'copilot', 'cursor'],
        run: async (provider) => {
          const cliTypeMap: Record<string, CliType | undefined> = {
            'claude-cli': 'claude',
            'codex-cli': 'codex',
            'gemini-cli': 'gemini',
            'copilot': 'copilot',
            'cursor': 'cursor',
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
          const report = await CliDetectionService.getInstance().detectShadowInstalls(cliType);
          const latencyMs = Date.now() - start;

          if (!report) {
            return {
              name: 'cli_shadow_check',
              status: 'pass' as const,
              message: 'Single active install (no shadows detected)',
              latencyMs,
            };
          }

          const versionList = report.installs
            .map((i) => `${i.path} (v${i.version ?? '?'})`)
            .join('\n  ');
          return {
            name: 'cli_shadow_check',
            status: 'fail' as const,
            message: `Multiple ${cliType} installs with different versions:\n  ${versionList}`,
            latencyMs,
            metadata: { report: report as unknown as Record<string, unknown> },
          };
        },
      },
      {
        name: 'authenticated',
        description: 'Check if the provider has valid credentials',
        critical: false,
        appliesTo: ['claude-cli', 'codex-cli', 'gemini-cli', 'anthropic-api'],
        run: async (provider) => {
          if (provider === 'claude-cli') {
            const start = Date.now();
            const authStatus = await checkClaudeCliAuthentication();
            return {
              name: 'authenticated',
              status: authStatus.authenticated ? 'pass' as const : 'fail' as const,
              message: authStatus.message,
              latencyMs: Date.now() - start,
              metadata: authStatus.metadata,
            };
          }

          if (provider === 'codex-cli') {
            const start = Date.now();
            const authStatus = await checkCodexCliAuthentication();
            return {
              name: 'authenticated',
              status: authStatus.authenticated ? 'pass' as const : 'fail' as const,
              message: authStatus.message,
              latencyMs: Date.now() - start,
              metadata: authStatus.metadata,
            };
          }

          if (provider === 'gemini-cli') {
            const start = Date.now();
            const authStatus = await checkGeminiCliAuthentication();
            return {
              name: 'authenticated',
              status: authStatus.authenticated ? 'pass' as const : 'fail' as const,
              message: authStatus.message,
              latencyMs: Date.now() - start,
              metadata: authStatus.metadata,
            };
          }

          if (provider === 'anthropic-api') {
            const hasKey = !!process.env['ANTHROPIC_API_KEY'];
            return {
              name: 'authenticated',
              status: hasKey ? 'pass' as const : 'fail' as const,
              message: hasKey ? 'ANTHROPIC_API_KEY is set' : 'ANTHROPIC_API_KEY not found in environment',
              latencyMs: 0,
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
            };
          }
        },
      },
    ];
  }

  getProbesForProvider(provider: string): ProbeDefinition[] {
    return this.probes.filter(p => p.appliesTo.includes(provider));
  }

  async diagnose(provider: string): Promise<DiagnosisResult> {
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
        });
      }
    }

    const diagnosis: DiagnosisResult = {
      provider,
      probes: results,
      overall: this.aggregateProbeResults(results),
      recommendations: this.generateRecommendations(provider, results),
      timestamp: Date.now(),
    };

    this.lastDiagnosis.set(provider, diagnosis);
    logger.info('Provider diagnosis complete', { provider, overall: diagnosis.overall });
    return diagnosis;
  }

  aggregateProbeResults(probes: ProbeResult[]): HealthStatus {
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
          const installCmds: Record<string, string> = {
            'claude-cli': 'npm install -g @anthropic-ai/claude-code',
            'codex-cli': 'npm install -g @openai/codex',
            'gemini-cli': 'npm install -g @google/gemini-cli',
            'copilot': 'Install GitHub CLI and run `gh copilot`, or install `npm install -g @github/copilot`',
            'cursor': 'Install Cursor and ensure `cursor-agent` is on PATH',
          };
          recs.push(`CLI not found. To install: ${installCmds[provider] ?? 'Check docs'}`);
          break;
        }
        case 'cli_shadow_check': {
          const report = probe.metadata?.['report'] as CliShadowReport | undefined;
          if (report && report.installs.length >= 2) {
            const stale = report.installs.slice(1);
            const lines = stale.map((i) => {
              const uninstallHint = inferUninstallHint(i.path);
              return `- ${i.path} (v${i.version ?? '?'})${uninstallHint ? ` — uninstall: ${uninstallHint}` : ''}`;
            });
            recs.push(
              `Shadow install detected. Active: ${report.activePath} (v${report.activeVersion ?? '?'}). Remove the stale copies so the active install is the only one:\n${lines.join('\n')}`,
            );
          } else {
            recs.push(`Shadow check failed: ${probe.message}`);
          }
          break;
        }
        case 'authenticated':
          if (provider === 'claude-cli') {
            recs.push(
              'Authentication missing. Run `claude auth login` to sign in, then retry diagnostics. If the CLI still looks unhealthy, run `claude doctor` in a trusted terminal.'
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
}

export function getProviderDoctor(): ProviderDoctor {
  return ProviderDoctor.getInstance();
}

/**
 * Best-effort hint on how to remove a stale CLI copy based on its install
 * path.  Returns null when we can't confidently suggest a command.
 */
function inferUninstallHint(installPath: string): string | null {
  if (installPath.startsWith('/opt/homebrew/')) {
    const binName = installPath.split('/').pop();
    return `/opt/homebrew/bin/npm uninstall -g <package>  # ${binName} under Homebrew's node`;
  }
  if (installPath.startsWith('/usr/local/')) {
    const binName = installPath.split('/').pop();
    return `/usr/local/bin/npm uninstall -g <package>  # ${binName} under system npm`;
  }
  if (installPath.includes('/.nvm/versions/node/')) {
    return 'nvm install handled — keep this one if it is the newest';
  }
  return null;
}
