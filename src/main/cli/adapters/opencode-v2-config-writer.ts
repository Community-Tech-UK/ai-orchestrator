import { openCodeRecord } from './opencode-config-shapes';

const nativeAction = (action: string) => action === 'bash' ? 'shell' : action === 'task' ? 'subagent' : action;
function permissionRules(value: unknown): unknown[] {
  if (Array.isArray(value)) return structuredClone(value);
  const permissions = typeof value === 'string' ? { '*': value } : openCodeRecord(value);
  return Object.entries(permissions).flatMap(([action, raw]) => {
    const resources = typeof raw === 'string' ? { '*': raw } : openCodeRecord(raw);
    return Object.entries(resources).map(([resource, effect]) => ({ action: nativeAction(action), resource, effect }));
  });
}
function requestOptions(value: unknown): { settings: Record<string, unknown>; body: Record<string, unknown> } {
  const settings = { ...openCodeRecord(value) };
  const body: Record<string, unknown> = {};
  if (settings['max_completion_tokens'] !== undefined) {
    body['max_completion_tokens'] = settings['max_completion_tokens'];
    delete settings['max_completion_tokens'];
  }
  return { settings, body };
}
/** Budget overlays contain only caps; retain the original native variant configuration. */
function mergeVariants(previous: unknown, incoming: unknown): Record<string, unknown>[] {
  const variants = new Map<string, Record<string, unknown>>();
  for (const layer of [previous, incoming]) {
    const entries = Array.isArray(layer) ? layer : Object.entries(openCodeRecord(layer))
      .map(([id, options]) => ({ id, ...requestOptions(options) }));
    for (const raw of entries) {
      const variant = openCodeRecord(raw);
      const id = variant['id'];
      if (typeof id !== 'string' || !id.trim()) throw new Error('Unsupported native variant configuration');
      for (const key of ['settings', 'body']) {
        const value = variant[key];
        if (value !== undefined && (typeof value !== 'object' || value === null || Array.isArray(value))) throw new Error('Unsupported native variant configuration');
      }
      const existing = variants.get(id) ?? {};
      variants.set(id, { ...existing, ...variant,
        settings: { ...openCodeRecord(existing['settings']), ...openCodeRecord(variant['settings']) },
        body: { ...openCodeRecord(existing['body']), ...openCodeRecord(variant['body']) },
      });
    }
  }
  return [...variants.values()];
}
function nativeModel(raw: unknown, previousVariants?: unknown): Record<string, unknown> {
  const model = { ...openCodeRecord(raw) };
  const { settings, body } = requestOptions(model['options']);
  const result: Record<string, unknown> = { ...model, settings: { ...settings, ...openCodeRecord(model['settings']) }, body: { ...openCodeRecord(model['body']), ...body } };
  const modalities = openCodeRecord(model['modalities']);
  const capabilities = { ...openCodeRecord(model['capabilities']),
    ...(typeof model['tool_call'] === 'boolean' ? { tools: model['tool_call'] } : {}), ...modalities };
  if (Object.keys(capabilities).length) result['capabilities'] = capabilities;
  const cost = openCodeRecord(model['cost']);
  if (cost['cache_read'] !== undefined || cost['cache_write'] !== undefined) {
    result['cost'] = { ...cost, cache: { ...openCodeRecord(cost['cache']),
      ...(cost['cache_read'] !== undefined ? { read: cost['cache_read'] } : {}),
      ...(cost['cache_write'] !== undefined ? { write: cost['cache_write'] } : {}),
    } };
    delete openCodeRecord(result['cost'])['cache_read'];
    delete openCodeRecord(result['cost'])['cache_write'];
  }
  const interleaved = openCodeRecord(model['interleaved']);
  if (typeof interleaved['field'] === 'string') result['compatibility'] = { ...openCodeRecord(model['compatibility']), reasoningField: interleaved['field'] };
  if (typeof model['npm'] === 'string') result['package'] = `aisdk:${model['npm']}`;
  if (model['variants'] !== undefined || previousVariants !== undefined) {
    result['variants'] = mergeVariants(previousVariants, model['variants']);
  }
  for (const key of ['options', 'npm', 'reasoning', 'tool_call', 'attachment', 'temperature', 'modalities', 'interleaved']) delete result[key];
  return result;
}

/** Emit native 2.x settings once the launcher has selected that major. */
export function serializeOpenCodeConfigForV2(config: Record<string, unknown>): void {
  const providers = { ...openCodeRecord(config['providers']) };
  for (const [id, raw] of Object.entries(openCodeRecord(config['provider']))) {
    const provider = { ...openCodeRecord(raw) };
    const npm = provider['npm'];
    const previous = openCodeRecord(providers[id]);
    const models = { ...openCodeRecord(previous['models']) };
    for (const [modelId, model] of Object.entries(openCodeRecord(provider['models']))) {
      const native = openCodeRecord(models[modelId]);
      const incoming = openCodeRecord(model);
      models[modelId] = nativeModel({ ...native, ...incoming, body: { ...openCodeRecord(native['body']), ...openCodeRecord(incoming['body']) } }, native['variants']);
    }
    providers[id] = { ...previous, ...provider,
      ...(typeof npm === 'string' ? { package: `aisdk:${npm}` } : {}),
      settings: { ...openCodeRecord(previous['settings']), ...openCodeRecord(provider['options']), ...openCodeRecord(provider['settings']) },
      models,
    };
    delete openCodeRecord(providers[id])['npm'];
    delete openCodeRecord(providers[id])['options'];
  }
  if (Object.keys(providers).length) config['providers'] = providers;
  if (config['permission'] !== undefined) config['permissions'] = [...(Array.isArray(config['permissions']) ? config['permissions'] : []), ...permissionRules(config['permission'])];
  const agents = { ...openCodeRecord(config['agents']) };
  for (const [name, raw] of Object.entries(openCodeRecord(config['agent']))) {
    const agent = { ...openCodeRecord(agents[name]), ...openCodeRecord(raw) };
    const inheritedRequest = openCodeRecord(openCodeRecord(agents[name])['request']);
    const options = requestOptions(agent['options']);
    const request = openCodeRecord(agent['request']);
    if (agent['max_completion_tokens'] !== undefined) options.body['max_completion_tokens'] = agent['max_completion_tokens'];
    agents[name] = { ...agent, ...(agent['prompt'] !== undefined ? { system: agent['prompt'] } : {}),
      ...(agent['disable'] !== undefined ? { disabled: agent['disable'] } : {}),
      request: { ...request, body: { ...openCodeRecord(inheritedRequest['body']), ...openCodeRecord(request['body']), ...options.body } },
      permissions: [...(Array.isArray(agent['permissions']) ? agent['permissions'] : []), ...permissionRules(agent['permission'])],
    };
    for (const key of ['permission', 'options', 'max_completion_tokens', 'prompt', 'disable']) delete openCodeRecord(agents[name])[key];
  }
  if (Object.keys(agents).length) config['agents'] = agents;
  for (const key of ['provider', 'permission', 'agent']) delete config[key];
}
