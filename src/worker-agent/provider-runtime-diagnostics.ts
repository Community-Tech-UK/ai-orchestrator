import { execFile } from 'child_process';
import { readFile as fsReadFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { CanonicalCliType } from '../shared/types/settings.types';

export type DiagnosableProvider = Exclude<CanonicalCliType, 'auto'>;

export type ProviderDiagnosticExec = (
  file: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv; timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;

type ProviderDiagnosticReadFile = (filePath: string) => Promise<string>;

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
  readFile?: ProviderDiagnosticReadFile;
  /** Test seam; production auth probes retain the 5-second deadline. */
  authProbeTimeoutMs?: number;
}

const COPILOT_AUTH_ENV_KEYS = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'] as const;
const MAX_COPILOT_CONFIG_BYTES = 1024 * 1024;
const PROVIDER_PROBE_TERMINATION_GRACE_MS = 250;

export async function diagnoseProviderRuntime(
  provider: DiagnosableProvider,
  options: DiagnoseOptions = {},
): Promise<ProviderRuntimeDiagnostic> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const run = options.exec ?? defaultExec;
  const readFile = options.readFile ?? defaultReadFile;
  const identity = await diagnoseIdentity(platform, env, run);

  if (provider === 'copilot') {
    const providerResult = await diagnoseCopilot(env, run, readFile, identity);
    return {
      ok: providerResult.available && providerResult.authenticated === true,
      platform,
      identity,
      provider: providerResult,
    };
  }

  const providerResult = await diagnoseGenericProvider(
    provider,
    env,
    run,
    options.authProbeTimeoutMs ?? 5_000,
  );
  return {
    ok: providerResult.available && providerResult.authenticated !== false,
    platform,
    identity,
    provider: providerResult,
  };
}

export function isDiagnosableProvider(value: unknown): value is DiagnosableProvider {
  return typeof value === 'string'
    && ['claude', 'gemini', 'antigravity', 'codex', 'copilot', 'cursor', 'grok'].includes(value);
}

async function diagnoseIdentity(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  run: ProviderDiagnosticExec,
): Promise<ProviderRuntimeDiagnosticIdentity> {
  let username: string | null = null;
  try {
    const result = await run('whoami', [], { env, timeout: 3_000 });
    username = truncateUtf8(result.stdout.trim(), 512) || null;
  } catch {
    username = null;
  }

  const homeDir = platform === 'win32'
    ? truncateNullable(env['USERPROFILE'], 2_048)
    : truncateNullable(env['HOME'], 2_048);
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
  readFile: ProviderDiagnosticReadFile,
  identity: ProviderRuntimeDiagnosticIdentity,
): Promise<ProviderRuntimeDiagnosticProvider> {
  const tokenEnv = Object.fromEntries(
    COPILOT_AUTH_ENV_KEYS.map((key) => [key, Boolean(env[key])]),
  ) as Record<(typeof COPILOT_AUTH_ENV_KEYS)[number], boolean>;

  let version: string | undefined;
  try {
    const result = await run('copilot', ['--version'], { env, timeout: 5_000 });
    version = extractVersion(`${result.stdout}\n${result.stderr}`);
  } catch {
    return {
      provider: 'copilot',
      available: false,
      authenticated: null,
      tokenEnv,
      error: 'Copilot CLI version probe failed.',
      remediation: 'Install GitHub Copilot CLI on this worker node, then run provider diagnostics again.',
    };
  }

  const authenticated = await readCopilotAuthentication(identity.homeDir, readFile);
  if (authenticated) {
    return {
      provider: 'copilot',
      available: true,
      authenticated: true,
      version,
      tokenEnv,
    };
  }
  return {
    provider: 'copilot',
    available: true,
    authenticated: false,
    version,
    tokenEnv,
    error: 'Copilot authentication could not be confirmed from local config state.',
    remediation: buildCopilotRemediation(identity, tokenEnv),
  };
}

interface CopilotConfigIdentity {
  host: string;
  login: string;
}

async function readCopilotAuthentication(
  homeDir: string | null,
  readFile: ProviderDiagnosticReadFile,
): Promise<boolean> {
  if (!homeDir) return false;
  let raw: string;
  try {
    raw = await readFile(join(homeDir, '.copilot', 'config.json'));
  } catch {
    return false;
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_COPILOT_CONFIG_BYTES) return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCopilotConfigLineComments(raw)) as unknown;
  } catch {
    return false;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed['loggedInUsers'])) return false;
  const users = parsed['loggedInUsers'].map(parseCopilotIdentity);
  if (users.length === 0 || users.some((user) => user === null)) return false;

  const identities = users as CopilotConfigIdentity[];
  if (parsed['lastLoggedInUser'] === undefined) {
    return identities.length === 1;
  }
  const active = parseCopilotIdentity(parsed['lastLoggedInUser']);
  if (!active) return false;
  return identities.filter((user) => sameCopilotIdentity(user, active)).length === 1;
}

function parseCopilotIdentity(value: unknown): CopilotConfigIdentity | null {
  if (!isRecord(value)) return null;
  const host = value['host'];
  const login = value['login'];
  if (typeof host !== 'string' || !host.trim() || typeof login !== 'string' || !login.trim()) {
    return null;
  }
  return { host: host.trim(), login: login.trim() };
}

function sameCopilotIdentity(a: CopilotConfigIdentity, b: CopilotConfigIdentity): boolean {
  return a.host.toLowerCase() === b.host.toLowerCase()
    && a.login.toLowerCase() === b.login.toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stripCopilotConfigLineComments(input: string): string {
  return input.replace(/^[ \t]*\/\/.*$/gm, '');
}

async function diagnoseGenericProvider(
  provider: DiagnosableProvider,
  env: NodeJS.ProcessEnv,
  run: ProviderDiagnosticExec,
  authProbeTimeoutMs: number,
): Promise<ProviderRuntimeDiagnosticProvider> {
  const command = provider === 'cursor'
    ? 'cursor-agent'
    : provider === 'antigravity'
      ? 'agy'
      : provider;
  try {
    const result = await run(command, ['--version'], { env, timeout: 5_000 });
    const authenticated = await diagnoseGenericAuthentication(
      provider,
      env,
      run,
      authProbeTimeoutMs,
    );
    return {
      provider,
      available: true,
      authenticated,
      version: extractVersion(`${result.stdout}\n${result.stderr}`),
      ...(authenticated === false && canSafelyProbeAuthentication(provider)
        ? { remediation: buildGenericAuthRemediation(provider) }
        : {}),
    };
  } catch (error) {
    return {
      provider,
      available: false,
      authenticated: canSafelyProbeAuthentication(provider) && isProviderProbeTimeout(error)
        ? false
        : null,
      error: errorToMessage(error),
    };
  }
}

async function diagnoseGenericAuthentication(
  provider: DiagnosableProvider,
  env: NodeJS.ProcessEnv,
  run: ProviderDiagnosticExec,
  timeout: number,
): Promise<boolean | null> {
  try {
    if (provider === 'cursor') {
      const result = await run('cursor-agent', ['status', '--format', 'json'], {
        env: { ...env, NO_OPEN_BROWSER: '1' },
        timeout,
      });
      return parseCursorAuthentication(`${result.stdout}\n${result.stderr}`) === true;
    }
    if (provider === 'claude') {
      const result = await run('claude', ['auth', 'status'], {
        env: { ...env, NO_OPEN_BROWSER: '1' },
        timeout,
      });
      return parseClaudeAuthentication(result.stdout) === true;
    }
    if (provider === 'codex') {
      const result = await run('codex', ['login', 'status'], {
        env: { ...env, NO_OPEN_BROWSER: '1' },
        timeout,
      });
      return parseCodexAuthentication(`${result.stdout}\n${result.stderr}`) === true;
    }
    if (provider === 'antigravity') {
      const result = await run('agy', ['models'], {
        env: { ...env, NO_OPEN_BROWSER: '1' },
        timeout,
      });
      return parseAntigravityAuthentication(`${result.stdout}\n${result.stderr}`);
    }
    return null;
  } catch {
    // Captured output is not trustworthy when the process itself failed or
    // timed out: some CLIs print cached positive status before exiting badly.
    // A successful process completion is required for positive auth evidence.
    return canSafelyProbeAuthentication(provider) ? false : null;
  }
}

function canSafelyProbeAuthentication(provider: DiagnosableProvider): boolean {
  return provider === 'antigravity'
    || provider === 'claude'
    || provider === 'codex'
    || provider === 'cursor';
}

function isProviderProbeTimeout(error: unknown): boolean {
  return error instanceof Error
    && (error.name === 'TimeoutError' || error.message === 'provider_probe_timeout');
}

const ANTIGRAVITY_AUTH_FAILURE_PATTERNS = [
  /\bnot (?:authenticated|logged in|signed in)\b/,
  /\b(?:unauthenticated|log(?:ged)? out|sign(?:ed)? out|signout|unau?r?thori[sz]ed|forbidden|access (?:is )?denied)\b/,
  /\b(?:authentication|authorization|auth) (?:error|failed|required)\b/,
  /\bfailed to authenticate\b/,
  /\bauthenticate(?: to continue)?\b/,
  /\b(?:login(?: required)?|log in|sign in)\b/,
  /\bexpired\b/,
  /\b(?:401|403)\b/,
  /\b(?:error|fatal)\b/,
] as const;
const ANTIGRAVITY_MODEL_CATALOGUE = new Map<string, string>([
  ['gemini-3.8-flash-high', 'Gemini 3.8 Flash (High)'],
  ['gemini-3.8-flash-medium', 'Gemini 3.8 Flash (Medium)'],
  ['gemini-3.8-flash-low', 'Gemini 3.8 Flash (Low)'],
  ['gemini-3.7-flash-high', 'Gemini 3.7 Flash (High)'],
  ['gemini-3.7-flash-medium', 'Gemini 3.7 Flash (Medium)'],
  ['gemini-3.7-flash-low', 'Gemini 3.7 Flash (Low)'],
  ['gemini-3.6-flash-high', 'Gemini 3.6 Flash (High)'],
  ['gemini-3.6-flash-medium', 'Gemini 3.6 Flash (Medium)'],
  ['gemini-3.6-flash-low', 'Gemini 3.6 Flash (Low)'],
  ['gemini-3.1-pro-high', 'Gemini 3.1 Pro (High)'],
  ['gemini-3.1-pro-low', 'Gemini 3.1 Pro (Low)'],
  ['claude-sonnet-4-6', 'Claude Sonnet 4.6 (Thinking)'],
  ['claude-opus-4-6-thinking', 'Claude Opus 4.6 (Thinking)'],
  ['gpt-oss-120b-medium', 'GPT-OSS 120B (Medium)'],
]);
const ANSI_SGR_SEQUENCE_PATTERN = /^\u001B\[[0-9;:]*m/u;
const C1_SGR_SEQUENCE_PATTERN = /^\u009B[0-9;:]*m/u;
const UNICODE_CONTROL_OR_FORMAT_PATTERN = /[\p{Cc}\p{Cf}]/gu;
const SINGLE_UNICODE_CONTROL_OR_FORMAT_PATTERN = /[\p{Cc}\p{Cf}]/u;

function isAntigravityModelCatalogueRow(line: string): boolean {
  const row = line
    .trim()
    .replace(/^(?:[-*•>✓✔●○]|\d+[.)])\s+/, '')
    .replace(/\s*(?:\[(?:current|default|selected)\]|\((?:current|default|selected)\))\s*$/i, '');
  const separatorIndex = row.indexOf('\t');
  if (separatorIndex >= 0) {
    const id = row.slice(0, separatorIndex).trim();
    const label = row.slice(separatorIndex + 1).trim();
    return ANTIGRAVITY_MODEL_CATALOGUE.get(id) === label;
  }
  return false;
}

function parseAntigravityAuthentication(output: string): boolean {
  const sanitized = stripVTControlCharacters(output);
  const normalized = sanitized.trim();
  const authComparables = [
    normalized,
    output.replace(UNICODE_CONTROL_OR_FORMAT_PATTERN, ''),
  ].map(normalizeAntigravityAuthText);
  const hasAuthFailure = ANTIGRAVITY_AUTH_FAILURE_PATTERNS.some(
    (pattern) => authComparables.some((authComparable) => pattern.test(authComparable)),
  );
  if (
    !normalized
    || hasAuthFailure
    || hasUnrecognizedTerminalControl(output)
  ) {
    return false;
  }
  return normalized.split(/\r?\n/).some(isAntigravityModelCatalogueRow);
}

function normalizeAntigravityAuthText(output: string): string {
  return output
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function hasUnrecognizedTerminalControl(output: string): boolean {
  for (let index = 0; index < output.length; index++) {
    const candidate = output.slice(index);
    const sgrSequence = candidate.match(ANSI_SGR_SEQUENCE_PATTERN)
      ?? candidate.match(C1_SGR_SEQUENCE_PATTERN);
    if (sgrSequence) {
      index += sgrSequence[0].length - 1;
      continue;
    }

    const character = output[index] ?? '';
    if (character === '\t' || character === '\n' || character === '\r') {
      continue;
    }
    if (SINGLE_UNICODE_CONTROL_OR_FORMAT_PATTERN.test(character)) {
      return true;
    }
  }
  return false;
}

function parseClaudeAuthentication(output: string): boolean | null {
  try {
    const parsed = JSON.parse(output.trim()) as { loggedIn?: unknown };
    return typeof parsed.loggedIn === 'boolean' ? parsed.loggedIn : null;
  } catch {
    return null;
  }
}

function parseCodexAuthentication(output: string): boolean | null {
  const normalized = output.trim().toLowerCase();
  if (
    normalized.includes('not logged in')
    || normalized.includes('login required')
    || normalized.includes('logged out')
  ) {
    return false;
  }
  return normalized.includes('logged in') ? true : null;
}

function parseCursorAuthentication(output: string): boolean | null {
  try {
    const parsed = JSON.parse(output.trim()) as Record<string, unknown>;
    for (const key of ['authenticated', 'isAuthenticated', 'loggedIn']) {
      if (typeof parsed[key] === 'boolean') {
        return parsed[key];
      }
    }
    const status = typeof parsed['status'] === 'string'
      ? parsed['status'].trim().toLowerCase().replace(/[\s-]+/g, '_')
      : '';
    if (['authenticated', 'logged_in', 'signed_in'].includes(status)) {
      return true;
    }
    if (['unauthenticated', 'not_logged_in', 'logged_out', 'signed_out'].includes(status)) {
      return false;
    }
    return null;
  } catch {
    return null;
  }
}

function buildGenericAuthRemediation(provider: DiagnosableProvider): string {
  if (provider === 'antigravity') {
    return 'Sign in to Antigravity CLI in the worker user context, then run provider diagnostics again.';
  }
  if (provider === 'cursor') {
    return 'Sign in to Cursor CLI in the worker user context, then run provider diagnostics again.';
  }
  if (provider === 'claude') {
    return 'Sign in to Claude CLI in the worker user context, then run provider diagnostics again.';
  }
  return 'Sign in to Codex CLI in the worker user context, then run provider diagnostics again.';
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
    return truncateText(details || error.message);
  }
  return truncateText(String(error));
}

function truncateText(value: string, maxLength = 2_000): string {
  return truncateUtf8(value, maxLength);
}

function truncateNullable(value: string | undefined, maxBytes: number): string | null {
  return value === undefined ? null : truncateUtf8(value, maxBytes);
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

const defaultReadFile: ProviderDiagnosticReadFile = async (filePath) => {
  return fsReadFile(filePath, 'utf8');
};

const defaultExec: ProviderDiagnosticExec = (file, args, options) => {
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadlineExpired = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: { stdout: string; stderr: string } | Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (result instanceof Error) {
        reject(result);
        return;
      }
      resolve(result);
    };
    const timeoutError = () => Object.assign(new Error('provider_probe_timeout'), {
      stdout: '',
      stderr: '',
    });
    const child = execFile(file, args, {
      encoding: 'utf8',
      env: options?.env,
    }, (error, stdout, stderr) => {
      if (deadlineExpired) {
        finish(timeoutError());
        return;
      }
      if (error) {
        finish(Object.assign(error, { stdout, stderr }));
        return;
      }
      finish({ stdout, stderr });
    });
    if (options?.timeout !== undefined) {
      deadlineTimer = setTimeout(() => {
        deadlineExpired = true;
        child.kill('SIGTERM');
        forceKillTimer = setTimeout(() => {
          child.kill('SIGKILL');
          child.stdin?.destroy();
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.unref();
          finish(timeoutError());
        }, PROVIDER_PROBE_TERMINATION_GRACE_MS);
      }, options.timeout);
    }
  });
};
