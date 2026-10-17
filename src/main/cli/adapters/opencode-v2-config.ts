import { openCodePositive, openCodeRecord } from './opencode-config-shapes';

const PERMISSION_EFFECTS = new Set(['ask', 'allow', 'deny']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Keep native rule order separately: repeated actions can target different resources. */
function rulesetToPermission(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const permission: Record<string, unknown> = {};
  for (const rule of normalizedRules(value)) {
    const legacyAction = rule.action === 'shell' ? 'bash' : rule.action === 'subagent' ? 'task' : rule.action;
    if (rule.resource === '*') permission[legacyAction] = rule.effect;
  }
  return permission;
}

export interface OpenCodePermissionRule { action: string; resource: string; effect: string }
export function normalizedRules(value: unknown): OpenCodePermissionRule[] {
  if (!Array.isArray(value)) return [];
  return value.map((rule: unknown) => {
    if (!isRecord(rule) || typeof rule['action'] !== 'string' || rule['action'].length > 256
      || typeof rule['resource'] !== 'string' || !PERMISSION_EFFECTS.has(String(rule['effect']))) {
      throw new Error('Unsupported native permission configuration');
    }
    return { action: rule['action'], resource: rule['resource'], effect: String(rule['effect']) };
  });
}

function numericCap(model: Record<string, unknown>): number | undefined {
  const caps = ['body', 'settings', 'options'].flatMap((key) => {
    const layer = openCodeRecord(model[key]);
    return [openCodePositive(layer['max_completion_tokens']), openCodePositive(layer['maxTokens'])];
  }).filter((cap): cap is number => cap !== undefined);
  return caps.length ? Math.min(...caps) : undefined;
}

function modelRef(value: unknown): unknown {
  if (typeof value === 'string' || value === undefined) return value;
  if (!isRecord(value)) return undefined;
  const providerId = value['providerID'];
  const modelId = value['id'] ?? value['modelID'] ?? value['model'];
  if (typeof providerId !== 'string' || typeof modelId !== 'string') return undefined;
  return `${providerId}/${modelId}`;
}

function mapVariants(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  if (!Array.isArray(value)) return undefined;
  const variants = new Map<string, Record<string, unknown>>();
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry['id'] !== 'string' || !entry['id'].trim()
      || (entry['settings'] !== undefined && !isRecord(entry['settings']))) {
      throw new Error('Unsupported native variant configuration');
    }
    const settings = openCodeRecord(entry['settings']);
    const completionCap = numericCap(entry);
    const tokenCap = openCodePositive(settings['maxTokens']);
    const caps = [completionCap, tokenCap].filter((cap): cap is number => cap !== undefined);
    // Effort-only variants inherit the model ceiling. Keep their names so the
    // budget overlay clamps them too, without retaining private native settings.
    variants.set(entry['id'], caps.length ? { max_completion_tokens: Math.min(...caps) } : {});
  }
  return variants.size ? Object.fromEntries(variants) : undefined;
}

function mapModel(model: Record<string, unknown>): Record<string, unknown> {
  const limit = openCodeRecord(model['limit']);
  const options = openCodeRecord(model['options']);
  const cap = numericCap(model) ?? limit['output'];
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
    models[id] = {
      ...previous,
      ...next,
      limit: { ...openCodeRecord(previous['limit']), ...openCodeRecord(next['limit']) },
      options: { ...openCodeRecord(previous['options']), ...openCodeRecord(next['options']) },
      settings: { ...openCodeRecord(previous['settings']), ...openCodeRecord(next['settings']) },
      body: { ...openCodeRecord(previous['body']), ...openCodeRecord(next['body']) },
    };
  }
  return { ...base, ...extra, models };
}

function mapAgent(agent: Record<string, unknown>): Record<string, unknown> {
  const permission = rulesetToPermission(agent['permission'] ?? agent['permissions']);
  const model = modelRef(agent['model']);
  const rules = normalizedRules(agent['permissions']);
  const cap = numericCap({ body: openCodeRecord(agent['request'])['body'], options: agent['options'] });
  return {
    ...agent,
    ...(model !== undefined ? { model } : {}),
    ...(rules.length ? { permissionRules: rules } : {}),
    ...(cap !== undefined ? { options: { ...openCodeRecord(agent['options']), max_completion_tokens: cap } } : {}),
    ...(agent['disable'] === true || agent['disabled'] === true ? { disable: true } : {}),
    ...(permission !== undefined ? { permission } : {}),
  };
}

function mergeInfo(target: Record<string, unknown>, info: Record<string, unknown>): void {
  const model = modelRef(info['model']);
  if (model !== undefined) target['model'] = model;
  const incomingAgents = openCodeRecord(info['agent'] ?? info['agents']);
  if (Object.keys(incomingAgents).length) {
    const agents = { ...openCodeRecord(target['agent']) };
    for (const [name, raw] of Object.entries(incomingAgents)) {
      const previous = openCodeRecord(agents[name]);
      const next = openCodeRecord(raw);
      const previousRequest = openCodeRecord(previous['request']);
      const nextRequest = openCodeRecord(next['request']);
      agents[name] = { ...previous, ...next,
        options: { ...openCodeRecord(previous['options']), ...openCodeRecord(next['options']) },
        request: { ...previousRequest, ...nextRequest, body: { ...openCodeRecord(previousRequest['body']), ...openCodeRecord(nextRequest['body']) } },
        ...((Array.isArray(previous['permissions']) || Array.isArray(next['permissions'])) ? {
          permissions: [...(Array.isArray(previous['permissions']) ? previous['permissions'] : []), ...(Array.isArray(next['permissions']) ? next['permissions'] : [])],
        } : {}),
      };
    }
    target['agent'] = agents;
  }
  const rules = normalizedRules(info['permissions']);
  if (rules.length) target['permissionRules'] = [...(Array.isArray(target['permissionRules']) ? target['permissionRules'] : []), ...rules];
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
  // Project only after merging: a synthesized alias from an earlier document
  // must never hide a later document overriding the same native body field.
  const providers = openCodeRecord(merged['provider']);
  for (const raw of Object.values(providers)) {
    const provider = openCodeRecord(raw);
    provider['models'] = Object.fromEntries(Object.entries(openCodeRecord(provider['models'])).map(([id, model]) => [id, mapModel(openCodeRecord(model))]));
  }
  const agents = openCodeRecord(merged['agent']);
  for (const [name, raw] of Object.entries(agents)) agents[name] = mapAgent(openCodeRecord(raw));
  return merged;
}

/** OpenCode 2 reads `providers`, and ignores the OpenCode 1 `provider` key. */
export function mirrorOpenCodeProviderForV2(config: Record<string, unknown>): void {
  const legacy = openCodeRecord(config['provider']);
  if (!Object.keys(legacy).length) return;
  const providers = openCodeRecord(config['providers']);
  config['providers'] = { ...structuredClone(providers), ...structuredClone(legacy) };
}

export { serializeOpenCodeConfigForV2 } from './opencode-v2-config-writer';
