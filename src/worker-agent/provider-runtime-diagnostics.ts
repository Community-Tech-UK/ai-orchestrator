import { execFile } from 'child_process';
import type { CanonicalCliType } from '../shared/types/settings.types';

export type DiagnosableProvider = Exclude<CanonicalCliType, 'auto'>;

export type ProviderDiagnosticExec = (
  file: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv; timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;

export interface ProviderRuntimeDiagnosticIdentity {
  username: string | null;
  homeDir: string | null;
  serviceAccountLikely: boolean;
}

export interface ProviderRuntimeDiagnosticProvider {
  provider: DiagnosableProvider;
  available: boolean;
  authenticated: boolean | null;
  version?: string;
  tokenEnv?: Record<string, boolean>;
  error?: string;
  remediation?: string;
}

export interface ProviderRuntimeDiagnostic {
  ok: boolean;
  platform: NodeJS.Platform;
  identity: ProviderRuntimeDiagnosticIdentity;
  provider: ProviderRuntimeDiagnosticProvider;
}

interface DiagnoseOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exec?: ProviderDiagnosticExec;
}

const COPILOT_AUTH_ENV_KEYS = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'] as const;

export async function diagnoseProviderRuntime(
  provider: DiagnosableProvider,
  options: DiagnoseOptions = {},
): Promise<ProviderRuntimeDiagnostic> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const run = options.exec ?? defaultExec;
  const identity = await diagnoseIdentity(platform, env, run);

  if (provider === 'copilot') {
    const providerResult = await diagnoseCopilot(env, run, identity);
    return {
      ok: providerResult.available && providerResult.authenticated === true,
      platform,
      identity,
      provider: providerResult,
    };
  }

  const providerResult = await diagnoseGenericProvider(provider, env, run);
  return {
    ok: providerResult.available,
    platform,
    identity,
    provider: providerResult,
  };
}

export function isDiagnosableProvider(value: unknown): value is DiagnosableProvider {
  return typeof value === 'string'
    && ['claude', 'gemini', 'codex', 'copilot', 'cursor'].includes(value);
}

async function diagnoseIdentity(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  run: ProviderDiagnosticExec,
): Promise<ProviderRuntimeDiagnosticIdentity> {
  let username: string | null = null;
  try {
    const result = await run('whoami', [], { env, timeout: 3_000 });
    username = result.stdout.trim() || null;
  } catch {
    username = null;
  }

  const homeDir = platform === 'win32'
    ? env['USERPROFILE'] ?? null
    : env['HOME'] ?? null;
  const normalizedUser = username?.toLowerCase() ?? '';
  const serviceAccountLikely = normalizedUser.startsWith('nt service\\')
    || normalizedUser === 'orchestrator'
    || normalizedUser === '_orchestrator';

  return {
    username,
    homeDir,
    serviceAccountLikely,
  };
}

async function diagnoseCopilot(
  env: NodeJS.ProcessEnv,
  run: ProviderDiagnosticExec,
  identity: ProviderRuntimeDiagnosticIdentity,
): Promise<ProviderRuntimeDiagnosticProvider> {
  const tokenEnv = Object.fromEntries(
    COPILOT_AUTH_ENV_KEYS.map((key) => [key, Boolean(env[key])]),
  ) as Record<(typeof COPILOT_AUTH_ENV_KEYS)[number], boolean>;

  let version: string | undefined;
  try {
    const result = await run('copilot', ['--version'], { env, timeout: 5_000 });
    version = extractVersion(`${result.stdout}\n${result.stderr}`);
  } catch (error) {
    return {
      provider: 'copilot',
      available: false,
      authenticated: null,
      tokenEnv,
      error: errorToMessage(error),
      remediation: 'Install GitHub Copilot CLI on this worker node, then run provider diagnostics again.',
    };
  }

  try {
    await run(
      'copilot',
      [
        '-p',
        'say ok',
        '--allow-all-tools',
        '--no-auto-update',
        '--log-level',
        'none',
        '--output-format',
        'json',
        '--stream',
        'off',
      ],
      { env, timeout: 30_000 },
    );
    return {
      provider: 'copilot',
      available: true,
      authenticated: true,
      version,
      tokenEnv,
    };
  } catch (error) {
    return {
      provider: 'copilot',
      available: true,
      authenticated: false,
      version,
      tokenEnv,
      error: errorToMessage(error),
      remediation: buildCopilotRemediation(identity, tokenEnv),
    };
  }
}

async function diagnoseGenericProvider(
  provider: DiagnosableProvider,
  env: NodeJS.ProcessEnv,
  run: ProviderDiagnosticExec,
): Promise<ProviderRuntimeDiagnosticProvider> {
  const command = provider === 'cursor' ? 'cursor-agent' : provider;
  try {
    const result = await run(command, ['--version'], { env, timeout: 5_000 });
    return {
      provider,
      available: true,
      authenticated: null,
      version: extractVersion(`${result.stdout}\n${result.stderr}`),
    };
  } catch (error) {
    return {
      provider,
      available: false,
      authenticated: null,
      error: errorToMessage(error),
    };
  }
}

function buildCopilotRemediation(
  identity: ProviderRuntimeDiagnosticIdentity,
  tokenEnv: Record<string, boolean>,
): string {
  if (Object.values(tokenEnv).some(Boolean)) {
    return 'A Copilot token environment variable is set, but the worker-context Copilot probe still failed. Verify the token has Copilot Requests permission and is visible to the worker process.';
  }

  if (identity.serviceAccountLikely) {
    return 'Run the worker provider runner as your Windows user, or set COPILOT_GITHUB_TOKEN/GH_TOKEN in the worker service environment. Copilot auth stored in your normal desktop profile is not visible to this service account.';
  }

  return 'Run `copilot login` in this worker user context, or set COPILOT_GITHUB_TOKEN/GH_TOKEN for the worker process.';
}

function extractVersion(output: string): string | undefined {
  return output.match(/\d+\.\d+\.\d+/)?.[0];
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error) {
    const maybeIo = error as Error & { stdout?: string; stderr?: string };
    const details = [maybeIo.stderr, maybeIo.stdout]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join('\n')
      .trim();
    return details || error.message;
  }
  return String(error);
}

const defaultExec: ProviderDiagnosticExec = (file, args, options) => {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      encoding: 'utf8',
      env: options?.env,
      timeout: options?.timeout,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
};
