import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { dirname, isAbsolute, join } from 'path';
import { getLogger } from '../logging/logger';
import { buildCliSpawnOptions } from './cli-environment';
import {
  CliDetectionService,
  CLI_REGISTRY,
  SUPPORTED_CLIS,
  type CliInfo,
  type CliType,
  type DetectionResult,
} from './cli-detection';
import {
  resolveCopilotCliLaunch,
  type CopilotCliLaunchConfig,
} from './copilot-cli-launch';

const logger = getLogger('CliUpdateService');

const DEFAULT_UPDATE_TIMEOUT_MS = 300_000;
const OUTPUT_PREVIEW_MAX_CHARS = 12_000;

interface CliUpdateSpec {
  npmPackage?: string;
  selfUpdateArgs?: string[];
  ghExtension?: string;
  brewFormula?: string;
}

const CLI_UPDATE_SPECS: Partial<Record<CliType, CliUpdateSpec>> = {
  claude: {
    npmPackage: '@anthropic-ai/claude-code',
    selfUpdateArgs: ['update'],
  },
  codex: {
    npmPackage: '@openai/codex',
  },
  gemini: {
    npmPackage: '@google/gemini-cli',
  },
  copilot: {
    npmPackage: '@github/copilot',
    selfUpdateArgs: ['update'],
    ghExtension: 'github/gh-copilot',
  },
  cursor: {
    selfUpdateArgs: ['update'],
  },
  ollama: {
    brewFormula: 'ollama',
  },
};

export interface CliUpdatePlan {
  cli: CliType;
  displayName: string;
  supported: boolean;
  command?: string;
  args?: string[];
  displayCommand?: string;
  activePath?: string;
  currentVersion?: string;
  reason?: string;
}

export type CliUpdateStatus = 'updated' | 'failed' | 'skipped';

export interface CliUpdateResult {
  cli: CliType;
  displayName: string;
  status: CliUpdateStatus;
  message: string;
  command?: string;
  beforeVersion?: string;
  afterVersion?: string;
  stdout?: string;
  stderr?: string;
  durationMs: number;
}

interface CliUpdateDetection {
  clearCache(): void;
  detectAll(forceRefresh?: boolean): Promise<DetectionResult>;
  detectOne(type: CliType): Promise<CliInfo>;
  scanAllCliInstalls(type: CliType): Promise<{ path: string; version?: string }[]>;
}

export interface CliUpdateServiceDeps {
  detection?: CliUpdateDetection;
  env?: NodeJS.ProcessEnv;
  execFileAsync?: (
    file: string,
    args: string[],
    timeoutMs: number,
    env: NodeJS.ProcessEnv,
    platform: NodeJS.Platform,
  ) => Promise<{ stdout: string; stderr: string }>;
  exists?: (path: string) => boolean;
  platform?: NodeJS.Platform;
  resolveCopilotLaunch?: (
    env?: NodeJS.ProcessEnv,
    platform?: NodeJS.Platform,
  ) => CopilotCliLaunchConfig | null;
}

function trimOutput(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length <= OUTPUT_PREVIEW_MAX_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(-OUTPUT_PREVIEW_MAX_CHARS)}\n[truncated ${trimmed.length - OUTPUT_PREVIEW_MAX_CHARS} chars]`;
}

function formatDisplayCommand(command: string, args: string[]): string {
  return [command, ...args]
    .map((part) => /^[A-Za-z0-9_./:@=+-]+$/.test(part) ? part : JSON.stringify(part))
    .join(' ');
}

function defaultExecFileAsync(
  file: string,
  args: string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      ...buildCliSpawnOptions(env, platform),
    }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export class CliUpdateService {
  private static instance: CliUpdateService | null = null;

  private readonly detection: CliUpdateDetection;
  private readonly env: NodeJS.ProcessEnv;
  private readonly execFileAsync: NonNullable<CliUpdateServiceDeps['execFileAsync']>;
  private readonly exists: (path: string) => boolean;
  private readonly platform: NodeJS.Platform;
  private readonly resolveCopilotLaunch: NonNullable<CliUpdateServiceDeps['resolveCopilotLaunch']>;

  constructor(deps: CliUpdateServiceDeps = {}) {
    this.detection = deps.detection ?? CliDetectionService.getInstance();
    this.env = deps.env ?? process.env;
    this.execFileAsync = deps.execFileAsync ?? defaultExecFileAsync;
    this.exists = deps.exists ?? existsSync;
    this.platform = deps.platform ?? process.platform;
    this.resolveCopilotLaunch = deps.resolveCopilotLaunch ?? resolveCopilotCliLaunch;
  }

  static getInstance(): CliUpdateService {
    if (!this.instance) {
      this.instance = new CliUpdateService();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  async getUpdatePlan(type: CliType): Promise<CliUpdatePlan> {
    const info = await this.detection.detectOne(type);
    return this.buildPlan(type, info);
  }

  async updateOne(type: CliType): Promise<CliUpdateResult> {
    const startedAt = Date.now();
    const plan = await this.getUpdatePlan(type);
    if (!plan.supported || !plan.command || !plan.args) {
      return {
        cli: type,
        displayName: plan.displayName,
        status: 'skipped',
        message: plan.reason ?? 'No automatic updater is available for this CLI.',
        beforeVersion: plan.currentVersion,
        durationMs: Date.now() - startedAt,
      };
    }

    logger.info('Updating CLI', {
      cli: type,
      command: plan.command,
      args: plan.args,
      beforeVersion: plan.currentVersion,
    });

    try {
      const output = await this.execFileAsync(
        plan.command,
        plan.args,
        DEFAULT_UPDATE_TIMEOUT_MS,
        this.env,
        this.platform,
      );

      this.detection.clearCache();
      const afterInfo = await this.detection.detectOne(type).catch(() => null);
      const afterVersion = afterInfo?.version;

      return {
        cli: type,
        displayName: plan.displayName,
        status: 'updated',
        command: plan.displayCommand,
        beforeVersion: plan.currentVersion,
        afterVersion,
        message: afterVersion && afterVersion !== plan.currentVersion
          ? `Updated from ${plan.currentVersion ?? '?'} to ${afterVersion}.`
          : 'Update command completed.',
        stdout: trimOutput(output.stdout),
        stderr: trimOutput(output.stderr),
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      const err = error as Error & { stdout?: string; stderr?: string };
      logger.warn('CLI update failed', {
        cli: type,
        command: plan.command,
        args: plan.args,
        error: err.message,
      });
      return {
        cli: type,
        displayName: plan.displayName,
        status: 'failed',
        command: plan.displayCommand,
        beforeVersion: plan.currentVersion,
        message: err.message,
        stdout: trimOutput(err.stdout ?? ''),
        stderr: trimOutput(err.stderr ?? ''),
        durationMs: Date.now() - startedAt,
      };
    }
  }

  async updateAllInstalled(): Promise<CliUpdateResult[]> {
    const detection = await this.detection.detectAll(true);
    const installed = SUPPORTED_CLIS.filter((type) =>
      detection.detected.some((info) => info.name === type && info.installed)
    );
    const results: CliUpdateResult[] = [];

    for (const type of installed) {
      results.push(await this.updateOne(type));
    }

    return results;
  }

  private async buildPlan(type: CliType, info: CliInfo): Promise<CliUpdatePlan> {
    const displayName = CLI_REGISTRY[type]?.displayName ?? type;
    const installs = await this.detection.scanAllCliInstalls(type).catch(() => []);
    const activePath = installs[0]?.path ?? info.path;
    const currentVersion = installs[0]?.version ?? info.version;
    const base: CliUpdatePlan = {
      cli: type,
      displayName,
      supported: false,
      activePath,
      currentVersion,
    };

    if (!info.installed) {
      return {
        ...base,
        reason: `${displayName} is not installed.`,
      };
    }

    if (type === 'copilot') {
      const copilotPlan = this.buildCopilotPlan(base);
      if (copilotPlan) {
        return copilotPlan;
      }
    }

    const spec = CLI_UPDATE_SPECS[type];
    if (!spec) {
      return {
        ...base,
        reason: `No automatic updater is configured for ${displayName}.`,
      };
    }

    if (spec.selfUpdateArgs) {
      const command = this.resolveRunnableCommand(activePath, CLI_REGISTRY[type]?.command ?? type);
      return this.withCommand(base, command, spec.selfUpdateArgs);
    }

    if (spec.npmPackage) {
      const command = this.resolveSiblingNpm(activePath);
      const args = ['install', '-g', `${spec.npmPackage}@latest`];
      return this.withCommand(base, command, args);
    }

    if (spec.brewFormula && activePath && this.isHomebrewPath(activePath)) {
      const command = this.resolveHomebrewCommand(activePath);
      return this.withCommand(base, command, ['upgrade', spec.brewFormula]);
    }

    return {
      ...base,
      reason: `${displayName} does not expose a safe automatic updater for this install path.`,
    };
  }

  private buildCopilotPlan(base: CliUpdatePlan): CliUpdatePlan | null {
    const launch = this.resolveCopilotLaunch(this.env, this.platform);
    if (!launch) {
      return null;
    }

    if (launch.argsPrefix.length > 0) {
      const extension = CLI_UPDATE_SPECS.copilot?.ghExtension;
      if (!extension) {
        return null;
      }
      return this.withCommand(base, launch.command, ['extension', 'upgrade', extension]);
    }

    return this.withCommand(base, launch.command, CLI_UPDATE_SPECS.copilot?.selfUpdateArgs ?? ['update']);
  }

  private withCommand(base: CliUpdatePlan, command: string, args: string[]): CliUpdatePlan {
    return {
      ...base,
      supported: true,
      command,
      args,
      displayCommand: formatDisplayCommand(command, args),
      reason: undefined,
    };
  }

  private resolveRunnableCommand(activePath: string | undefined, fallbackCommand: string): string {
    if (activePath && isAbsolute(activePath) && this.exists(activePath)) {
      return activePath;
    }
    return fallbackCommand;
  }

  private resolveSiblingNpm(activePath: string | undefined): string {
    if (activePath && isAbsolute(activePath)) {
      const dir = dirname(activePath);
      const candidates = this.platform === 'win32'
        ? [join(dir, 'npm.cmd'), join(dir, 'npm'), 'npm.cmd', 'npm']
        : [join(dir, 'npm'), 'npm'];
      const found = candidates.find((candidate) => candidate === 'npm' || candidate === 'npm.cmd' || this.exists(candidate));
      if (found) {
        return found;
      }
    }
    return this.platform === 'win32' ? 'npm.cmd' : 'npm';
  }

  private isHomebrewPath(activePath: string): boolean {
    return activePath.startsWith('/opt/homebrew/') || activePath.startsWith('/usr/local/');
  }

  private resolveHomebrewCommand(activePath: string): string {
    if (activePath.startsWith('/opt/homebrew/') && this.exists('/opt/homebrew/bin/brew')) {
      return '/opt/homebrew/bin/brew';
    }
    if (activePath.startsWith('/usr/local/') && this.exists('/usr/local/bin/brew')) {
      return '/usr/local/bin/brew';
    }
    return 'brew';
  }
}

export function getCliUpdateService(): CliUpdateService {
  return CliUpdateService.getInstance();
}
