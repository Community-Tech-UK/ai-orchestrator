import { execFile } from 'child_process';
import { existsSync, realpathSync } from 'fs';
import { posix as pathPosix, win32 as pathWin32 } from 'path';
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
import type { CliUpdateStrategy } from '../../shared/types/diagnostics.types';

const logger = getLogger('CliUpdateService');

/** Official Ollama macOS/Linux updater — re-runs the upstream install script. */
const OLLAMA_INSTALL_SCRIPT_CMD = 'curl -fsSL https://ollama.com/install.sh | sh';

const DEFAULT_UPDATE_TIMEOUT_MS = 300_000;
const OUTPUT_PREVIEW_MAX_CHARS = 12_000;

export interface CliUpdateSpec {
  npmPackage?: string;
  selfUpdateArgs?: string[];
  ghExtension?: string;
  brewFormula?: string;
}

export const CLI_UPDATE_SPECS: Partial<Record<CliType, CliUpdateSpec>> = {
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
  // Antigravity ships as a self-contained binary (not an npm package); it
  // self-updates via `agy update`. Replaces the Gemini CLI's npm updater.
  antigravity: {
    selfUpdateArgs: ['update'],
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

/**
 * Strategies safe to apply unattended (policy `'auto'`): package-manager global
 * installs and a CLI's own self-updater. Deliberately excludes `homebrew`
 * (can trigger wide formula upgrades) and `gh-extension` — matching the plan's
 * "npm / native self-update only, never an unattended brew/sudo".
 */
const AUTO_APPLY_SAFE_STRATEGIES: ReadonlySet<CliUpdateStrategy> = new Set([
  'npm',
  'bun',
  'pnpm',
  'self-update',
]);

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
  /** Present only on a `supported` plan. */
  strategy?: CliUpdateStrategy;
  /**
   * Concurrency key: shared per package manager (so two npm updates serialise)
   * and per-CLI for self-update/gh-extension. Present only on a supported plan.
   */
  lockKey?: string;
}

/**
 * Whether a plan would be applied via an unattended-safe strategy. Accepts the
 * serialisable summary shape (what the auto-update service sees via pill
 * entries); an absent/unknown strategy is treated as NOT safe.
 */
export function isAutoApplySafe(
  plan: { strategy?: string | null } | null | undefined,
): boolean {
  return Boolean(plan?.strategy && AUTO_APPLY_SAFE_STRATEGIES.has(plan.strategy as CliUpdateStrategy));
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
  /** Resolve symlinks for an absolute path (injectable for tests). Defaults to
   *  fs.realpathSync; callers should tolerate it throwing on missing paths. */
  realpath?: (path: string) => string;
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

/**
 * Concurrency key for an update strategy. Package-manager strategies share one
 * key (so two npm/bun/pnpm global installs never run at once — they mutate the
 * same global root); per-CLI strategies key by CLI (independent binaries).
 */
function lockKeyFor(strategy: CliUpdateStrategy, cli: CliType): string {
  switch (strategy) {
    case 'npm':
    case 'bun':
    case 'pnpm':
      return `pm:${strategy}`;
    case 'homebrew':
      return 'pm:homebrew';
    case 'self-update':
    case 'gh-extension':
    case 'install-script':
      return `cli:${cli}`;
  }
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
  private readonly realpath: (path: string) => string;
  private readonly platform: NodeJS.Platform;
  private readonly resolveCopilotLaunch: NonNullable<CliUpdateServiceDeps['resolveCopilotLaunch']>;
  /** Per-lockKey promise chain so same-key updates never run concurrently. */
  private readonly locks = new Map<string, Promise<unknown>>();

  /**
   * Path helpers bound to the *target* platform (`this.platform`), not the host
   * running the process. Install paths are classified for the machine the CLI
   * lives on, so `join`/`dirname`/`isAbsolute` must use win32 vs posix semantics
   * to match — otherwise a posix path on a Windows host (or vice-versa) is split
   * on the wrong separator and sibling-executable probes miss.
   */
  private get path(): typeof pathPosix {
    return this.platform === 'win32' ? pathWin32 : pathPosix;
  }

  constructor(deps: CliUpdateServiceDeps = {}) {
    this.detection = deps.detection ?? CliDetectionService.getInstance();
    this.env = deps.env ?? process.env;
    this.execFileAsync = deps.execFileAsync ?? defaultExecFileAsync;
    this.exists = deps.exists ?? existsSync;
    this.realpath = deps.realpath ?? ((p: string) => realpathSync(p));
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

    // Serialise updates that share a package manager (e.g. two npm globals) so
    // concurrent "Update all" + auto-update passes can't corrupt a global root.
    const command = plan.command;
    const args = plan.args;
    return this.runExclusive(plan.lockKey ?? `cli:${type}`, async () => {
      try {
        const output = await this.execFileAsync(
          command,
          args,
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
          command,
          args,
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
    });
  }

  /**
   * Serialise `fn` against others sharing `key` via a per-key promise chain.
   * The stored handle swallows rejection so one failed update never rejects the
   * next caller waiting on the same key.
   */
  private runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(key) ?? Promise.resolve();
    const run = prior.then(() => fn());
    this.locks.set(key, run.then(() => undefined, () => undefined));
    return run;
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

    if (type === 'ollama') {
      return this.buildOllamaPlan(base, activePath);
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
      return this.withCommand(base, command, spec.selfUpdateArgs, 'self-update');
    }

    if (spec.npmPackage) {
      return this.buildNpmFamilyPlan(base, spec.npmPackage, activePath);
    }

    if (spec.brewFormula && activePath && this.isHomebrewPath(activePath)) {
      const command = this.resolveHomebrewCommand(activePath);
      return this.withCommand(base, command, ['upgrade', spec.brewFormula], 'homebrew');
    }

    return {
      ...base,
      reason: `${displayName} does not expose a safe automatic updater for this install path.`,
    };
  }

  /**
   * Ollama ships via three common paths: Homebrew (`Cellar/ollama`), the
   * official macOS app (symlink at `/usr/local/bin/ollama`), and the Linux
   * install script (`/usr/bin/ollama`). Path prefix alone is not enough —
   * `/usr/local/bin/ollama` is the official symlink, not Homebrew.
   */
  private buildOllamaPlan(base: CliUpdatePlan, activePath: string | undefined): CliUpdatePlan {
    if (!activePath) {
      return {
        ...base,
        reason: `${base.displayName} path could not be determined.`,
      };
    }

    const resolved = this.resolveRealPath(activePath);

    // Direct app-bundle binary — the desktop app has its own updater. The
    // standard `/usr/local/bin/ollama` shim resolves here too; that case is
    // handled below via the install script.
    if (this.pathIsUnder(activePath, '/Applications/Ollama.app')) {
      return {
        ...base,
        reason: `${base.displayName} is bundled with Ollama.app. Use the menu bar app (Restart to Update) or re-run the installer from ollama.com.`,
      };
    }

    if (this.isHomebrewCellarPath(resolved)) {
      const command = this.resolveHomebrewCommand(resolved);
      return this.withCommand(base, command, ['upgrade', 'ollama'], 'homebrew');
    }

    if (this.platform === 'darwin' || this.platform === 'linux') {
      return this.withCommand(base, '/bin/sh', ['-c', OLLAMA_INSTALL_SCRIPT_CMD], 'install-script');
    }

    return {
      ...base,
      reason: `${base.displayName} does not expose a safe automatic updater for this install path.`,
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
      return this.withCommand(base, launch.command, ['extension', 'upgrade', extension], 'gh-extension');
    }

    return this.withCommand(base, launch.command, CLI_UPDATE_SPECS.copilot?.selfUpdateArgs ?? ['update'], 'self-update');
  }

  private withCommand(
    base: CliUpdatePlan,
    command: string,
    args: string[],
    strategy: CliUpdateStrategy,
  ): CliUpdatePlan {
    return {
      ...base,
      supported: true,
      command,
      args,
      displayCommand: formatDisplayCommand(command, args),
      reason: undefined,
      strategy,
      lockKey: lockKeyFor(strategy, base.cli),
    };
  }

  private resolveRunnableCommand(activePath: string | undefined, fallbackCommand: string): string {
    if (activePath && this.path.isAbsolute(activePath) && this.exists(activePath)) {
      return activePath;
    }
    return fallbackCommand;
  }

  private resolveSiblingNpm(activePath: string | undefined): string {
    if (activePath && this.path.isAbsolute(activePath)) {
      const dir = this.path.dirname(activePath);
      const candidates = this.platform === 'win32'
        ? [this.path.join(dir, 'npm.cmd'), this.path.join(dir, 'npm'), 'npm.cmd', 'npm']
        : [this.path.join(dir, 'npm'), 'npm'];
      const found = candidates.find((candidate) => candidate === 'npm' || candidate === 'npm.cmd' || this.exists(candidate));
      if (found) {
        return found;
      }
    }
    return this.platform === 'win32' ? 'npm.cmd' : 'npm';
  }

  /**
   * Build the update plan for an npm-published CLI, choosing the package
   * manager the binary was actually installed with. The default path heuristic
   * always shelled out to `npm install -g`, which runs the WRONG manager when a
   * user installed the CLI via bun or pnpm (the update silently no-ops or
   * installs a parallel npm copy). We resolve symlinks first (a binary is often
   * symlinked into the manager's bin dir) and classify by the manager's global
   * root, falling back to npm — so detection failure never makes things worse.
   */
  private buildNpmFamilyPlan(
    base: CliUpdatePlan,
    npmPackage: string,
    activePath: string | undefined,
  ): CliUpdatePlan {
    const resolved = activePath ? this.resolveRealPath(activePath) : undefined;
    const probePaths = [activePath, resolved].filter((p): p is string => Boolean(p));

    if (probePaths.some((p) => this.isBunGlobalPath(p))) {
      return this.withCommand(base, this.resolveGlobalManager(activePath, 'bun'), ['add', '-g', `${npmPackage}@latest`], 'bun');
    }
    if (probePaths.some((p) => this.isPnpmGlobalPath(p))) {
      return this.withCommand(base, this.resolveGlobalManager(activePath, 'pnpm'), ['add', '-g', `${npmPackage}@latest`], 'pnpm');
    }
    // Default: npm (unchanged behaviour). Prefer a sibling npm of the original
    // (un-resolved) path — npm's bin dir holds the global shims.
    return this.withCommand(base, this.resolveSiblingNpm(activePath), ['install', '-g', `${npmPackage}@latest`], 'npm');
  }

  /** Resolve symlinks for an absolute path; returns the input on any failure. */
  private resolveRealPath(activePath: string): string {
    if (!this.path.isAbsolute(activePath)) {
      return activePath;
    }
    try {
      return this.realpath(activePath);
    } catch {
      return activePath;
    }
  }

  private homeDir(): string | undefined {
    return this.env['HOME'] || this.env['USERPROFILE'] || undefined;
  }

  /** True when `p` is the binary of a bun global install (`bun add -g`). */
  private isBunGlobalPath(p: string): boolean {
    const roots: string[] = [];
    const bunInstall = this.env['BUN_INSTALL'];
    if (bunInstall) roots.push(bunInstall);
    const home = this.homeDir();
    if (home) roots.push(this.path.join(home, '.bun'));
    return roots.some((root) => this.pathIsUnder(p, root));
  }

  /** True when `p` is the binary of a pnpm global install (`pnpm add -g`). */
  private isPnpmGlobalPath(p: string): boolean {
    const roots: string[] = [];
    const pnpmHome = this.env['PNPM_HOME'];
    if (pnpmHome) roots.push(pnpmHome);
    const home = this.homeDir();
    if (home) {
      roots.push(this.path.join(home, 'Library', 'pnpm')); // macOS default
      roots.push(this.path.join(home, '.local', 'share', 'pnpm')); // Linux default
    }
    const localAppData = this.env['LOCALAPPDATA'];
    if (localAppData) roots.push(this.path.join(localAppData, 'pnpm')); // Windows default
    return roots.some((root) => this.pathIsUnder(p, root));
  }

  /** Path-prefix containment that tolerates `\` vs `/` and a trailing slash. */
  private pathIsUnder(candidate: string, root: string): boolean {
    if (!root) return false;
    const norm = (s: string) => s.split('\\').join('/').replace(/\/+$/, '');
    const c = norm(candidate);
    const r = norm(root);
    return c === r || c.startsWith(`${r}/`);
  }

  /** Locate the bun/pnpm executable — a sibling of the CLI binary if present,
   *  else the bare command name (resolved via PATH at exec time). On Windows
   *  bun ships as `bun.exe` and pnpm as `pnpm.cmd`/`pnpm.exe`, so try both
   *  extensions there (mirrors `resolveSiblingNpm`'s multi-candidate probe). */
  private resolveGlobalManager(activePath: string | undefined, manager: 'bun' | 'pnpm'): string {
    if (activePath && this.path.isAbsolute(activePath)) {
      const dir = this.path.dirname(activePath);
      const siblings = this.platform === 'win32'
        ? [this.path.join(dir, `${manager}.cmd`), this.path.join(dir, `${manager}.exe`)]
        : [this.path.join(dir, manager)];
      const found = siblings.find((candidate) => this.exists(candidate));
      if (found) {
        return found;
      }
    }
    return manager;
  }

  private isHomebrewPath(activePath: string): boolean {
    return this.isHomebrewCellarPath(this.resolveRealPath(activePath));
  }

  /** True when the resolved binary lives under a Homebrew Cellar tree. */
  private isHomebrewCellarPath(resolvedPath: string): boolean {
    return resolvedPath.includes('/Cellar/');
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
