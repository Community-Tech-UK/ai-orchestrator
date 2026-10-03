/** Shared private projections for native configuration. Never retain credential-bearing options. */
export const openCodeRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function openCodePositive(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) throw new Error('Unsupported native numeric limit');
  return Math.floor(value);
}

export function openCodeModelConfig(config: Record<string, unknown>, model: string): Record<string, unknown> {
  const [providerId, ...modelParts] = model.split('/');
  const modelId = modelParts.join('/');
  return openCodeRecord(openCodeRecord(openCodeRecord(openCodeRecord(config['provider'])[providerId!])['models'])[modelId!]);
}

const identifier = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 256 || !/^[\w.:-]+\/[\w.:-]+(?:\/[\w.:-]+)*$/.test(value)) throw new Error('Unsupported native model identifier');
  return value;
};

/** Permission values are reduced to safe actions; path patterns and native values never leave the probe. */
function permissionKeys(value: unknown): Record<string, unknown> {
  const permission = typeof value === 'string' ? { '*': value } : openCodeRecord(value);
  return Object.fromEntries(Object.entries(permission).map(([key, action]) => [key,
    ['ask', 'allow', 'deny'].includes(String(action)) ? action : 'patterned',
  ]));
}

export function projectOpenCodeConfig(config: unknown, model?: string): Record<string, unknown> {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) throw new Error('Invalid native configuration');
  const native = openCodeRecord(config);
  const agents = Object.fromEntries(Object.entries(openCodeRecord(native['agent'])).map(([name, value]) => {
    const agent = openCodeRecord(value);
    const options = openCodeRecord(agent['options']);
    // Native AgentConfig.normalize moves unknown top-level fields into options, with top-level precedence.
    const cap = openCodePositive(Object.hasOwn(agent, 'max_completion_tokens') ? agent['max_completion_tokens'] : options['max_completion_tokens']);
    if (agent['mode'] !== undefined && !['primary', 'subagent', 'all'].includes(String(agent['mode']))) throw new Error('Unsupported native agent mode');
    return [name, { model: identifier(agent['model']), mode: agent['mode'], hidden: agent['hidden'] === true,
      disable: agent['disable'] === true, ...(Object.hasOwn(agent, 'max_completion_tokens') ? { max_completion_tokens: cap } : {}),
      options: { max_completion_tokens: cap }, permission: permissionKeys(agent['permission']) }];
  }));
  const result: Record<string, unknown> = {
    agent: agents, permission: permissionKeys(native['permission']),
    // A boolean marker, never plugin paths, arguments, or configuration values.
    ...(Array.isArray(native['plugin']) && native['plugin'].length ? { plugin: [true] } : {}),
    ...(native['small_model'] ? { small_model: identifier(native['small_model']) } : {}),
  };
  if (!model) return result;
  const [providerId, ...modelParts] = model.split('/');
  const modelId = modelParts.join('/');
  const selected = openCodeModelConfig(native, model);
  const limit = openCodeRecord(selected['limit']);
  const options = openCodeRecord(selected['options']);
  const variants = Object.fromEntries(Object.entries(openCodeRecord(selected['variants'])).map(([name, value]) => [name, {
    max_completion_tokens: openCodePositive(openCodeRecord(value)['max_completion_tokens']),
  }]));
  result['provider'] = { [providerId!]: { models: { [modelId!]: {
    limit: { context: openCodePositive(limit['context']), output: openCodePositive(limit['output']) },
    options: { max_completion_tokens: openCodePositive(options['max_completion_tokens']) },
    ...(Object.keys(variants).length ? { variants } : {}),
  } } } };
  return result;
}
