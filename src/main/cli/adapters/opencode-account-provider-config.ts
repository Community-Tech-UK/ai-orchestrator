/**
 * Per-account MiMo provider definitions for `OPENCODE_CONFIG_CONTENT`.
 *
 * OpenCode keeps one key store and one session store, and has no concept of two
 * accounts on the same Token Plan server. AIO therefore defines one extra
 * OpenCode provider per non-legacy MiMo account (`aio-mimo-<profileId>`, all
 * pointing at the account's region base URL, no `apiKey` here: OpenCode
 * resolves the key from its own key store under that provider name). The
 * built-in region provider's model metadata is copied at run time (never
 * hard-coded) so the injected models report the same limits, reasoning,
 * tool-call, attachment, `interleaved {field: "reasoning_content"}`, modalities
 * and effort variants as `xiaomi-token-plan-<region>` (probe finding P2).
 *
 * Everything here is secret-free: model limits and capability flags only.
 */

import {
  type OpenCodeAccountRegion,
  type ProviderAccountProfile,
  isOpenCodeAccountProviderName,
  opencodeAccountProviderName,
} from '../../../shared/types/provider-account.types';
import { normalizeModelForProvider } from '../../../shared/types/provider.types';

/** The account facts a spawn needs. Safe: no paths, no credentials. */
export interface OpenCodeAccountProviderDef {
  profileId: string;
  label: string;
  region: OpenCodeAccountRegion;
  /** Derived from the profile, never stored free-form. */
  providerName: string;
}

export function openCodeAccountProviderDef(
  profile: Pick<ProviderAccountProfile, 'id' | 'label' | 'isLegacy' | 'region'>,
): OpenCodeAccountProviderDef {
  return {
    profileId: profile.id,
    label: profile.label,
    region: profile.region!,
    providerName: opencodeAccountProviderName(profile),
  };
}

/** One `provider/model` header plus its resolved metadata JSON block. */
export interface OpenCodeModelMetadataBlock {
  providerId: string;
  modelId: string;
  metadata: Record<string, unknown>;
}

const MODEL_HEADER = /^([a-z0-9][\w.-]*)\/(\S+)\s*$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse `opencode models [<provider>] --verbose` output: one `provider/model`
 * header followed by a JSON metadata block per model. Unparseable blocks are
 * skipped rather than failing the read.
 */
export function parseOpenCodeModelMetadataBlocks(output: string): OpenCodeModelMetadataBlock[] {
  const lines = output.split(/\r?\n/);
  const blocks: OpenCodeModelMetadataBlock[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const header = MODEL_HEADER.exec(lines[index]?.trim() ?? '');
    if (!header) continue;
    const providerId = header[1] ?? '';
    const modelId = header[2] ?? '';
    const jsonLines: string[] = [];
    // Collect the JSON block only: brace-balanced (strings stripped first), so
    // trailing banner or error lines never poison the parse of this block.
    let depth = 0;
    let started = false;
    while (index + 1 < lines.length && !MODEL_HEADER.test(lines[index + 1]?.trim() ?? '')) {
      index += 1;
      const line = lines[index] ?? '';
      if (started || line.trim().startsWith('{')) {
        jsonLines.push(line);
        started = true;
        const stripped = line.replace(/"(?:[^"\\]|\\.)*"/g, '""');
        for (const char of stripped) {
          if (char === '{') depth += 1;
          else if (char === '}') depth -= 1;
        }
        if (depth <= 0) break;
      }
    }
    const json = jsonLines.join('\n').trim();
    if (!json.startsWith('{')) continue;
    try {
      const metadata: unknown = JSON.parse(json);
      if (isRecord(metadata)) blocks.push({ providerId, modelId, metadata });
    } catch {
      // Skip the block; the caller fails closed if it needed it.
    }
  }
  return blocks;
}

// Key-name heuristic over native model options: nothing that looks like
// credential material is ever kept (values are parameters, never secrets).
const CREDENTIAL_OPTION_KEY = /(^|[_-])(api_?key|key|secret|password|passwd|credential|cookie|authorization|auth_token|access_token|refresh_token|bearer)($|[_-])/i;

function safeOptions(value: unknown): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(isRecord(value) ? value : {})
      .filter(([key]) => !CREDENTIAL_OPTION_KEY.test(key)),
  );
}

const MODALITY_FIELDS = ['text', 'audio', 'image', 'video', 'pdf'] as const;

function modalitiesFrom(capabilities: Record<string, unknown>): Record<string, string[]> | undefined {
  const collect = (side: unknown): string[] | undefined => {
    if (!isRecord(side)) return undefined;
    return MODALITY_FIELDS.filter((field) => side[field] === true);
  };
  const input = collect(capabilities['input']);
  const output = collect(capabilities['output']);
  if (!input && !output) return undefined;
  return { ...(input ? { input } : {}), ...(output ? { output } : {}) };
}

/**
 * Copy one resolved `opencode models --verbose` metadata block into an
 * OpenCode config model entry. The verbose block exposes capabilities as
 * `capabilities.{reasoning,toolcall,attachment,interleaved,…}` while the config
 * schema names them `reasoning/tool_call/attachment/interleaved/modalities`
 * (probe finding P2).
 */
export function buildOpenCodeModelConfigEntry(metadata: Record<string, unknown>): Record<string, unknown> {
  const capabilities = isRecord(metadata['capabilities']) ? metadata['capabilities'] : {};
  const interleaved = capabilities['interleaved'];
  const modalities = modalitiesFrom(capabilities);
  const copyIfPresent = (key: string): Record<string, unknown> =>
    metadata[key] === undefined ? {} : { [key]: metadata[key] };
  return {
    ...copyIfPresent('name'),
    ...copyIfPresent('limit'),
    options: safeOptions(metadata['options']),
    ...copyIfPresent('variants'),
    ...copyIfPresent('cost'),
    reasoning: capabilities['reasoning'] === true,
    tool_call: capabilities['toolcall'] === true,
    attachment: capabilities['attachment'] === true,
    ...(isRecord(interleaved) ? { interleaved } : {}),
    ...(modalities ? { modalities } : {}),
    temperature: capabilities['temperature'] === true,
  };
}

/** Region base URLs, used when the metadata copy cannot supply `api.url`. */
export function openCodeAccountFallbackBaseUrl(region: OpenCodeAccountRegion): string {
  return `https://token-plan-${region}.xiaomimimo.com/v1`;
}

export interface OpenCodeAccountProviderBlocks {
  /** Provider definitions keyed by derived provider name, ready to merge. */
  blocks: Record<string, unknown>;
  /** Regions whose model metadata could not be read (their accounts are refused). */
  missingRegions: OpenCodeAccountRegion[];
}

/**
 * Build `provider.aio-mimo-*` definitions for the given accounts. Model
 * metadata is copied from the region's built-in provider metadata
 * (`opencode models xiaomi-token-plan-<region> --verbose`); an account whose
 * region metadata is unavailable is reported in `missingRegions` and gets no
 * block (the spawn path refuses a routed account in that state).
 */
export function buildOpenCodeAccountProviderBlocks(
  accounts: readonly OpenCodeAccountProviderDef[],
  metadataByRegion: (region: OpenCodeAccountRegion) => readonly OpenCodeModelMetadataBlock[] | null | undefined,
): OpenCodeAccountProviderBlocks {
  const blocks: Record<string, unknown> = {};
  const missingRegions = new Set<OpenCodeAccountRegion>();
  for (const account of accounts) {
    const metaBlocks = metadataByRegion(account.region);
    const usable = (metaBlocks ?? []).filter((block) => block.providerId === `xiaomi-token-plan-${account.region}`);
    if (usable.length === 0) {
      missingRegions.add(account.region);
      continue;
    }
    const api = isRecord(usable[0]?.metadata['api']) ? usable[0]!.metadata['api'] : {};
    const npm = typeof api['npm'] === 'string' ? api['npm'] : '@ai-sdk/openai-compatible';
    const baseURL = typeof api['url'] === 'string' && api['url'] ? api['url'] : openCodeAccountFallbackBaseUrl(account.region);
    const models = Object.fromEntries(usable.map((block) => [block.modelId, buildOpenCodeModelConfigEntry(block.metadata)]));
    blocks[account.providerName] = {
      npm,
      name: account.label,
      options: { baseURL },
      models,
    };
  }
  return { blocks, missingRegions: [...missingRegions] };
}

/**
 * Merge account provider definitions into an `OPENCODE_CONFIG_CONTENT` object.
 * AIO-managed `aio-mimo-*` names win; nothing else in `provider` is touched.
 */
export function applyOpenCodeAccountProviderBlocks(
  config: Record<string, unknown>,
  blocks: Record<string, unknown>,
): void {
  if (Object.keys(blocks).length === 0) return;
  const providers = isRecord(config['provider']) ? { ...config['provider'] } : {};
  Object.assign(providers, blocks);
  config['provider'] = providers;
}

/**
 * The session model to apply under an account route (Decision 4: the instance
 * keeps the logical `xiaomi-token-plan-<region>/<model>` id; the adapter swaps
 * the provider prefix). Other backends and a missing route keep their id.
 * Lives here (leaf module) so both the adapter factory and the live account
 * switch can derive it.
 */
export function resolveOpenCodeSessionModel(
  model: string | undefined,
  routedProviderName?: string | null,
): string | undefined {
  const requested = model?.trim();
  if (!requested || requested.toLowerCase() === 'auto') return undefined;
  const normalized = normalizeModelForProvider('opencode', requested)?.trim() || undefined;
  if (!normalized || !routedProviderName) return normalized;
  // Both logical MiMo forms swap: `xiaomi-token-plan/<model>` (legacy id) and
  // `xiaomi-token-plan-<region>/<model>` (the per-region id). Anything else
  // (`xiaomi-token-planning/…`, Zen, other backends) keeps its provider.
  const logicalMiMo = /^xiaomi-token-plan(?:-(?:ams|sgp|cn))?\//.test(normalized);
  // The existing account also has a derived target: its built-in regional
  // provider may differ from the logical model's original region.
  const legacyRegionProvider = /^xiaomi-token-plan-(?:ams|sgp|cn)$/.test(routedProviderName);
  if ((isOpenCodeAccountProviderName(routedProviderName) || legacyRegionProvider) && logicalMiMo) {
    const modelId = normalized.slice(normalized.indexOf('/') + 1);
    return `${routedProviderName}/${modelId}`;
  }
  return normalized;
}
