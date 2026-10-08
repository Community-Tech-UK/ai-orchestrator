import { openCodeRecord } from './opencode-config-shapes';

const PERMISSION_EFFECTS = new Set(['ask', 'allow', 'deny']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** OpenCode 2 stores permission rules as ordered `{action, resource, effect}` rows. */
function rulesetToPermission(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const permission: Record<string, unknown> = {};
  for (const rule of value) {
    if (!isRecord(rule) || typeof rule['action'] !== 'string' || rule['action'].length > 256) continue;
    if (!PERMISSION_EFFECTS.has(String(rule['effect']))) continue;
    permission[rule['action']] = rule['effect'];
  }
  return permission;
}

function modelRef(value: unknown): unknown {
  if (typeof value === 'string' || value === undefined) return value;
  if (!isRecord(value)) return undefined;
  const providerId = value['providerID'];
  const modelId = value['id'] ?? value['modelID'];
  if (typeof providerId !== 'string' || typeof modelId !== 'string') return undefined;
  return `${providerId}/${modelId}`;
}

function mapVariants(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  if (!Array.isArray(value)) return undefined;
  const variants: Record<string, unknown> = {};
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry['id'] !== 'string') continue;
    const settings = openCodeRecord(entry['settings']);
    const cap = settings['max_completion_tokens'] ?? settings['maxTokens'];
    if (typeof cap === 'number') variants[entry['id']] = { max_completion_tokens: cap };
  }
  if (value.length > 0 && Object.keys(variants).length === 0) {
    throw new Error('Unsupported native numeric limit');
  }
  return Object.keys(variants).length ? variants : undefined;
}

function mapModel(model: Record<string, unknown>): Record<string, unknown> {
  const limit = openCodeRecord(model['limit']);
  const options = openCodeRecord(model['options']);
  const cap = options['max_completion_tokens'] ?? limit['output'];
  const variants = mapVariants(model['variants']);
  const rest = { ...model };
  delete rest['variants'];
  return {
    ...rest,
    limit,
    options: { ...options, ...(typeof cap === 'number' ? { max_completion_tokens: cap } : {}) },
    ...(variants ? { variants } : {}),
  };
}

function mergeProvider(base: Record<string, unknown>, extra: Record<string, unknown>): Record<string, unknown> {
  const models = { ...openCodeRecord(base['models']) };
  for (const [id, raw] of Object.entries(openCodeRecord(extra['models']))) {
    const previous = openCodeRecord(models[id]);
    const next = openCodeRecord(raw);
    models[id] = mapModel({
      ...previous,
      ...next,
      limit: { ...openCodeRecord(previous['limit']), ...openCodeRecord(next['limit']) },
      options: { ...openCodeRecord(previous['options']), ...openCodeRecord(next['options']) },
    });
  }
  return { ...base, ...extra, models };
}

function mapAgent(agent: Record<string, unknown>): Record<string, unknown> {
  const permission = rulesetToPermission(agent['permission'] ?? agent['permissions']);
  const model = modelRef(agent['model']);
  return {
    ...agent,
    ...(model !== undefined ? { model } : {}),
    ...(agent['disable'] === true || agent['disabled'] === true ? { disable: true } : {}),
    ...(permission !== undefined ? { permission } : {}),
  };
}

function mergeInfo(target: Record<string, unknown>, info: Record<string, unknown>): void {
  const incomingAgents = openCodeRecord(info['agent'] ?? info['agents']);
  if (Object.keys(incomingAgents).length) {
    const agents = { ...openCodeRecord(target['agent']) };
    for (const [name, raw] of Object.entries(incomingAgents)) {
      agents[name] = mapAgent({ ...openCodeRecord(agents[name]), ...openCodeRecord(raw) });
    }
    target['agent'] = agents;
  }
  const permission = rulesetToPermission(info['permission'] ?? info['permissions']);
  if (isRecord(permission) && Object.keys(permission).length) {
    target['permission'] = { ...openCodeRecord(target['permission']), ...permission };
  }
  const plugins = info['plugin'] ?? info['plugins'];
  if (Array.isArray(plugins) && plugins.length) target['plugin'] = plugins;
  if (typeof info['small_model'] === 'string') target['small_model'] = info['small_model'];
  const incomingProviders = openCodeRecord(info['provider'] ?? info['providers']);
  if (!Object.keys(incomingProviders).length) return;
  const providers = { ...openCodeRecord(target['provider']) };
  for (const [id, raw] of Object.entries(incomingProviders)) {
    providers[id] = mergeProvider(openCodeRecord(providers[id]), openCodeRecord(raw));
  }
  target['provider'] = providers;
}

/**
 * OpenCode 2 `GET /api/config` lists source documents. Fold those documents into
 * the resolved object shape the generation-budget checks already understand.
 * A resolved OpenCode 1 object is returned unchanged.
 */
export function normalizeOpenCodeNativeConfig(config: unknown): unknown {
  if (!Array.isArray(config)) return config;
  const merged: Record<string, unknown> = {};
  for (const entry of config) {
    if (!isRecord(entry) || entry['type'] !== 'document') continue;
    mergeInfo(merged, openCodeRecord(entry['info']));
  }
  return merged;
}

/** OpenCode 2 reads `providers`, and ignores the OpenCode 1 `provider` key. */
export function mirrorOpenCodeProviderForV2(config: Record<string, unknown>): void {
  const legacy = openCodeRecord(config['provider']);
  if (!Object.keys(legacy).length) return;
  const providers = openCodeRecord(config['providers']);
  config['providers'] = { ...structuredClone(providers), ...structuredClone(legacy) };
}
