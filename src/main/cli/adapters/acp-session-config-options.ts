/**
 * ACP session config options (`session/set_config_option`).
 *
 * Some ACP agents (OpenCode) take no model or effort CLI flag. Instead
 * `session/new` and `session/load` return a `configOptions` list and the client
 * picks values with `session/set_config_option`. These helpers turn the
 * agent's untrusted option list into typed entries, plan which writes to send,
 * and send them without ever failing the spawn: a value the agent does not
 * advertise, or a write it rejects, becomes a warning and the session carries
 * on with the agent's own choice.
 *
 * Option ids and categories are observations, not a published contract
 * (OpenCode 1.18: `model`/`model`, `effort`/`thought_level`, `mode`/`mode`), so
 * each option is matched by its ACP category first and its id second.
 */

import type { ReasoningEffort } from '../../../shared/types/provider.types';

export interface AcpConfigOptionEntry {
  id: string;
  category?: string;
  currentValue?: string;
  values: string[];
}

/** The session settings AIO knows how to apply. `model` is always written first. */
export type AcpSessionConfigKey = 'model' | 'effort';

export interface AcpSessionConfigRequest {
  model?: string;
  effort?: string;
}

export type AcpConfigWritePlanEntry =
  | { kind: 'write'; key: AcpSessionConfigKey; configId: string; value: string }
  | { kind: 'skip'; key: AcpSessionConfigKey; value: string; reason: string };

const CONFIG_KEY_CATEGORIES: Record<AcpSessionConfigKey, string> = {
  model: 'model',
  effort: 'thought_level',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Flat `{value}` options plus ACP's grouped `{options: [...]}` form. */
function collectOptionValues(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const values: string[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    if (typeof item['value'] === 'string') {
      values.push(item['value']);
    } else if (Array.isArray(item['options'])) {
      values.push(...collectOptionValues(item['options']));
    }
  }
  return values;
}

/** Parse an untrusted `configOptions` array, dropping malformed entries. */
export function parseAcpConfigOptions(raw: unknown): AcpConfigOptionEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: AcpConfigOptionEntry[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item['id'] !== 'string' || !item['id'].trim()) continue;
    entries.push({
      id: item['id'],
      ...(typeof item['category'] === 'string' ? { category: item['category'] } : {}),
      ...(typeof item['currentValue'] === 'string' ? { currentValue: item['currentValue'] } : {}),
      values: collectOptionValues(item['options']),
    });
  }
  return entries;
}

function findOption(
  advertised: readonly AcpConfigOptionEntry[],
  key: AcpSessionConfigKey,
): AcpConfigOptionEntry | undefined {
  return advertised.find((option) => option.category === CONFIG_KEY_CATEGORIES[key])
    ?? advertised.find((option) => option.id === key);
}

/**
 * Plan one write. `advertised === null` means the agent returned no option
 * list (for example an agent whose `session/load` returns `null`); the write is
 * then sent unvalidated and the agent's own error is the signal.
 */
export function planConfigOptionWrite(
  advertised: readonly AcpConfigOptionEntry[] | null,
  key: AcpSessionConfigKey,
  value: string,
): AcpConfigWritePlanEntry {
  if (advertised === null) {
    return { kind: 'write', key, configId: key, value };
  }
  const option = findOption(advertised, key);
  if (!option) {
    return { kind: 'skip', key, value, reason: `the agent offers no ${key} option for this session` };
  }
  if (option.currentValue === value) {
    return { kind: 'skip', key, value, reason: 'already selected' };
  }
  if (!option.values.includes(value)) {
    return { kind: 'skip', key, value, reason: `the agent does not offer ${key} "${value}"` };
  }
  return { kind: 'write', key, configId: option.id, value };
}

/** Ordered plan for both writes against one option list: `model`, then `effort`. */
export function planConfigOptionWrites(
  advertised: readonly AcpConfigOptionEntry[] | null,
  requested: AcpSessionConfigRequest,
): AcpConfigWritePlanEntry[] {
  const plan: AcpConfigWritePlanEntry[] = [];
  if (requested.model) plan.push(planConfigOptionWrite(advertised, 'model', requested.model));
  if (requested.effort) plan.push(planConfigOptionWrite(advertised, 'effort', requested.effort));
  return plan;
}

/**
 * Map AIO's reasoning effort to the ACP `low|medium|high` scale (same mapping
 * as Grok's `--reasoning-effort`). `none`, `workflow` and unknown values
 * return undefined so the agent's per-model default applies.
 */
export function mapAcpEffort(effort: ReasoningEffort | string | null | undefined): 'low' | 'medium' | 'high' | undefined {
  const value = effort?.trim();
  if (!value) return undefined;
  if (value === 'minimal') return 'low';
  if (value === 'xhigh' || value === 'max' || value === 'ultra') return 'high';
  if (value === 'low' || value === 'medium' || value === 'high') return value;
  return undefined;
}

export type AcpSetConfigOption = (configId: string, value: string) => Promise<unknown>;

export interface AcpSessionConfigOutcome {
  applied: Array<{ key: AcpSessionConfigKey; value: string }>;
  /** Skips and rejected writes that the user should hear about. */
  warnings: string[];
}

/**
 * Apply the requested model and effort. The model is written first, and the
 * option list it returns is re-read before planning effort, because OpenCode
 * only offers `effort` for models that support it. Never throws.
 */
export async function applyAcpSessionConfig(
  setConfigOption: AcpSetConfigOption,
  initialOptions: unknown,
  requested: AcpSessionConfigRequest,
): Promise<AcpSessionConfigOutcome> {
  const outcome: AcpSessionConfigOutcome = { applied: [], warnings: [] };
  let advertised: AcpConfigOptionEntry[] | null = Array.isArray(initialOptions)
    ? parseAcpConfigOptions(initialOptions)
    : null;

  const keys: AcpSessionConfigKey[] = ['model', 'effort'];
  for (const key of keys) {
    const value = requested[key]?.trim();
    if (!value) continue;
    const entry = planConfigOptionWrite(advertised, key, value);
    if (entry.kind === 'skip') {
      if (entry.reason !== 'already selected') {
        outcome.warnings.push(`Did not set ${key} "${value}": ${entry.reason}.`);
      }
      continue;
    }
    try {
      const result = await setConfigOption(entry.configId, entry.value);
      outcome.applied.push({ key, value });
      if (isRecord(result) && Array.isArray(result['configOptions'])) {
        advertised = parseAcpConfigOptions(result['configOptions']);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcome.warnings.push(`Could not set ${key} "${value}": ${message}`);
    }
  }
  return outcome;
}
