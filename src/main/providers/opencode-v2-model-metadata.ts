import type { OpenCodeModelMetadataBlock } from '../cli/adapters/opencode-account-provider-config';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const SECRET_FIELD = /(^|[_-])(api_?key|key|secret|password|credential|cookie|authorization|auth_token|access_token|refresh_token|bearer)($|[_-])/i;
function safeParameters(value: unknown): Record<string, unknown> {
  const clean = (item: unknown): unknown => Array.isArray(item) ? item.map(clean) : record(item)
    ? Object.fromEntries(Object.entries(item).filter(([key]) => !SECRET_FIELD.test(key)).map(([key, nested]) => [key, clean(nested)])) : item;
  return clean(record(value) ? value : {}) as Record<string, unknown>;
}
function modalities(value: unknown): Record<string, boolean> {
  return Object.fromEntries((Array.isArray(value) ? value : []).filter((item): item is string => typeof item === 'string').map((item) => [item, true]));
}
/** Model.Info returned by OpenCode 2.0.30's standalone GET /api/model. */
export function parseOpenCodeV2ModelMetadata(output: string): OpenCodeModelMetadataBlock[] {
  let parsed: unknown;
  try { parsed = JSON.parse(output); } catch { return []; }
  if (!record(parsed) || !Array.isArray(parsed['data'])) return [];
  return parsed['data'].flatMap((row: unknown) => {
    if (!record(row) || row['enabled'] === false || typeof row['providerID'] !== 'string' || typeof row['modelID'] !== 'string'
      || !record(row['capabilities']) || !record(row['limit'])) return [];
    const capabilities = row['capabilities'];
    const variants = Object.fromEntries((Array.isArray(row['variants']) ? row['variants'] : []).flatMap((variant: unknown) =>
      record(variant) && typeof variant['id'] === 'string'
        ? [[variant['id'], { ...safeParameters(variant['settings']), ...safeParameters(variant['body']) }]] : []));
    return [{ providerId: row['providerID'], modelId: row['modelID'], metadata: {
      name: row['name'], limit: row['limit'], variants,
      ...(Array.isArray(row['cost']) && record(row['cost'][0]) ? { cost: { input: row['cost'][0]['input'], output: row['cost'][0]['output'], cache: row['cost'][0]['cache'] } } : {}),
      api: { npm: row['package'], url: record(row['settings']) ? row['settings']['baseURL'] : undefined },
      options: { ...safeParameters(row['settings']), ...safeParameters(row['body']) },
      capabilities: { toolcall: capabilities['tools'] === true, input: modalities(capabilities['input']), output: modalities(capabilities['output']),
        reasoning: record(row['compatibility']) && typeof row['compatibility']['reasoningField'] === 'string' || variants['thinking'] !== undefined || variants['high'] !== undefined,
        ...(record(row['compatibility']) && typeof row['compatibility']['reasoningField'] === 'string'
          ? { interleaved: { field: row['compatibility']['reasoningField'] } } : {}),
        attachment: Array.isArray(capabilities['input']) && capabilities['input'].some((item) => item !== 'text') },
    } }];
  });
}
