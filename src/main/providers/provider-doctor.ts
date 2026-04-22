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
import { checkClaudeCliAuthentication } from './claude-cli-auth';

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
          const cliMap: Record<string, string> = {
            'claude-cli': 'claude',
            'codex-cli': 'codex',
            'gemini-cli': 'gemini',
            'copilot': 'copilot',
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

          const envMap: Record<string, string> = {
            'anthropic-api': 'ANTHROPIC_API_KEY',
            'codex-cli': 'OPENAI_API_KEY',
            'gemini-cli': 'GOOGLE_API_KEY',
          };
          const envKey = envMap[provider];
          if (!envKey) {
            return {
              name: 'authenticated',
              status: 'skip' as const,
              message: 'No env key check',
              latencyMs: 0,
            };
          }

          const hasKey = !!process.env[envKey];
          return {
            name: 'authenticated',
            status: hasKey ? 'pass' as const : 'fail' as const,
            message: hasKey ? `${envKey} is set` : `${envKey} not found in environment`,
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
            'copilot': 'npm install -g @github/copilot',
            'cursor': 'Install Cursor and ensure `cursor-agent` is on PATH',
          };
          recs.push(`CLI not found. To install: ${installCmds[provider] ?? 'Check docs'}`);
          break;
        }
        case 'authenticated':
          if (provider === 'claude-cli') {
            recs.push(
              'Authentication missing. Run `claude auth login` to sign in, then retry diagnostics. If the CLI still looks unhealthy, run `claude doctor` in a trusted terminal.'
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
