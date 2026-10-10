/**
 * OpenCode sign-in status without touching credential values.
 *
 * `opencode auth list` prints provider names and credential types only, then
 * `N credentials`, and (when provider env vars are set) an `Environment` block
 * ending `N environment variable(s)`. Only those counts are read.
 *
 * With no credentials OpenCode still runs its free Zen models
 * (`opencode/...`); with no configured model its default is one of them
 * (probe: `opencode/big-pickle`). So an empty list only means "not signed in"
 * when the effective model points at a backend that needs a key, and that
 * backend has no `options.apiKey` in OpenCode's own config (a key kept in the
 * config file does not appear in `auth list`). Only the key's presence is
 * checked; its value is never read out or logged.
 */

export interface OpenCodeAuthCounts {
  credentials: number;
  environmentVariables: number;
}

// eslint-disable-next-line no-control-regex -- intentional: strips ANSI SGR escape sequences (ESC char)
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

export function parseOpenCodeAuthList(output: string): OpenCodeAuthCounts | null {
  const text = output.replace(ANSI_PATTERN, '');
  const credentials = /(\d+)\s+credentials?\b/i.exec(text);
  if (!credentials) return null;
  const environment = /(\d+)\s+environment variables?\b/i.exec(text);
  return {
    credentials: Number.parseInt(credentials[1] ?? '0', 10),
    environmentVariables: environment ? Number.parseInt(environment[1] ?? '0', 10) : 0,
  };
}

/**
 * Credential names as `opencode auth list` prints them: custom providers show
 * their provider id (`aio-mimo-max-b-1a2b`), catalog providers their display
 * name ("Xiaomi Token Plan (Europe)"). Names only — values never leave the CLI.
 * Only the `Credentials` block is read; the `Environment` block lists env-var
 * rows, not stored credentials.
 */
export function parseOpenCodeAuthCredentialNames(output: string): string[] {
  const text = output.replace(ANSI_PATTERN, '');
  const counts = parseOpenCodeAuthList(text);
  if (!counts || counts.credentials === 0) return [];
  const names: string[] = [];
  let inCredentialsBlock = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^[┌T]\s{1,2}/.test(line)) {
      inCredentialsBlock = /Credentials\b/.test(line);
      continue;
    }
    if (/\d+\s+credentials?\b/i.test(line)) {
      inCredentialsBlock = false;
      continue;
    }
    if (!inCredentialsBlock) continue;
    // `●  <name> <type>`; the name may contain spaces, the type never does.
    const row = /^[●•]\s+(.*)\s{1,}(\S+)\s*$/.exec(line);
    if (row?.[1]) names.push(row[1].trim());
  }
  return names;
}

/**
 * Display names OpenCode's own `auth list` uses for the built-in region
 * providers (probe finding P3). Keep in sync with `BACKEND_LABELS` in
 * `opencode-cli-discovery-service.ts`.
 */
export const OPENCODE_REGION_AUTH_LABELS: Readonly<Record<string, string>> = {
  ams: 'Xiaomi Token Plan (Europe)',
  sgp: 'Xiaomi Token Plan (Singapore)',
  cn: 'Xiaomi Token Plan (China)',
};

/**
 * Every name under which one account's credential may appear in `auth list`:
 * the derived provider id, plus the region display name for
 * `xiaomi-token-plan-<region>` legacy providers.
 */
export function openCodeAuthNamesFor(providerName: string): string[] {
  const names = [providerName];
  const region = /^xiaomi-token-plan-(ams|sgp|cn)$/.exec(providerName)?.[1];
  const label = region ? OPENCODE_REGION_AUTH_LABELS[region] : undefined;
  if (label) names.push(label);
  return names;
}

export function isOpenCodeFreeModel(model: string | undefined): boolean {
  return !model?.trim() || model.trim().startsWith('opencode/');
}

export function resolveOpenCodeAuthenticated(counts: OpenCodeAuthCounts, effectiveModel: string | undefined): boolean {
  return counts.credentials + counts.environmentVariables > 0 || isOpenCodeFreeModel(effectiveModel);
}

export interface OpenCodeConfigSummary {
  model?: string;
  /** Provider ids whose config carries a non-empty `options.apiKey`. */
  providersWithConfigKey: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Summarises `opencode debug config` output; empty when absent or unparseable. */
export function parseOpenCodeConfig(output: string): OpenCodeConfigSummary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    // Not JSON (older CLI or an error banner): treat as no configuration.
    return { providersWithConfigKey: [] };
  }
  if (!isRecord(parsed)) return { providersWithConfigKey: [] };
  const providers = isRecord(parsed['provider']) ? parsed['provider'] : {};
  const providersWithConfigKey = Object.entries(providers)
    .filter(([, config]) => {
      const options = isRecord(config) ? config['options'] : undefined;
      const apiKey = isRecord(options) ? options['apiKey'] : undefined;
      return typeof apiKey === 'string' && apiKey.trim().length > 0;
    })
    .map(([id]) => id);
  return {
    ...(typeof parsed['model'] === 'string' ? { model: parsed['model'] } : {}),
    providersWithConfigKey,
  };
}

function modelProviderId(model: string | undefined): string | undefined {
  const slash = model?.indexOf('/') ?? -1;
  return slash > 0 ? model!.slice(0, slash) : undefined;
}

export type OpenCodeCommandRunner = (args: string[]) => Promise<string>;

export interface OpenCodeAuthStatus {
  authenticated: boolean;
  counts: OpenCodeAuthCounts | null;
  effectiveModel?: string;
}

/**
 * `aioModel` is the model AIO will request (its configured default for
 * OpenCode), which wins over OpenCode's own configured model.
 */
export async function readOpenCodeAuthStatus(
  run: OpenCodeCommandRunner,
  aioModel: string | undefined,
): Promise<OpenCodeAuthStatus> {
  const counts = parseOpenCodeAuthList(await run(['auth', 'list']));
  if (!counts) {
    return { authenticated: false, counts: null };
  }
  if (counts.credentials + counts.environmentVariables > 0) {
    return { authenticated: true, counts };
  }
  const config = parseOpenCodeConfig(await run(['debug', 'config']));
  const effectiveModel = aioModel?.trim() || config.model;
  const backend = modelProviderId(effectiveModel);
  const keyInConfig = backend !== undefined && config.providersWithConfigKey.includes(backend);
  return {
    authenticated: keyInConfig || resolveOpenCodeAuthenticated(counts, effectiveModel),
    counts,
    ...(effectiveModel ? { effectiveModel } : {}),
  };
}
