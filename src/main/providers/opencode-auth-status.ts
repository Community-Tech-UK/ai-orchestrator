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
