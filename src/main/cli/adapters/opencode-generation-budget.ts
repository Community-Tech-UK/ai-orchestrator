import { openCodeModelConfig, openCodePositive, openCodeRecord } from './opencode-config-shapes';

export interface OpenCodeGenerationBudget {
  model: string;
  /** MiMo exposes a combined generation ceiling, not an independent reasoning budget. */
  combinedOutputTokens: number;
  reasoningBudgetSupported: false;
}
const scopedModel = (model: string | undefined) => model?.match(/^(xiaomi-token-plan(?:-[^/]+)?)\/(mimo-v2\.6-pro)$/);
const capOf = (options: Record<string, unknown>) => openCodePositive(options['max_completion_tokens']);

function scopedAgents(config: Record<string, unknown>, model: string): [string, Record<string, unknown>][] {
  return Object.entries(openCodeRecord(config['agent'])).filter(([name, raw]) => {
    const agent = openCodeRecord(raw);
    if (agent['disable'] === true) return false;
    const options = openCodeRecord(agent['options']);
    const cap = capOf(Object.hasOwn(agent, 'max_completion_tokens') ? agent : options);
    const mode = agent['mode'] ?? (['general', 'explore'].includes(name) ? 'subagent' : 'all');
    if (agent['model'] && agent['model'] !== model) {
      // ACP supplies session.model ahead of a primary agent's model. Only native Task fixes a subagent model.
      if (cap !== undefined && mode !== 'subagent') throw new Error('Unable to scope the OpenCode generation budget to cross-model primary agents safely.');
      return false;
    }
    // Hidden native summarizers may use small_model. Avoid changing that model's inherited agent budget.
    if (cap !== undefined && ['title', 'summary'].includes(name) && config['small_model'] !== model) {
      throw new Error('Unable to scope the OpenCode generation budget to native auxiliary agents safely.');
    }
    return true;
  }).map(([name, raw]) => [name, openCodeRecord(raw)]);
}

/** Clamp every supported native precedence layer to one truthful, scoped combined ceiling. */
export function applyOpenCodeGenerationBudget(base: Record<string, unknown>, model: string | undefined, effectiveConfig?: Record<string, unknown>): OpenCodeGenerationBudget | undefined {
  const match = scopedModel(model);
  if (!match || !model) return undefined;
  const providerId = match[1]!;
  const modelId = match[2]!;
  for (const config of [base, effectiveConfig ?? {}]) {
    if (Array.isArray(config['plugin']) && config['plugin'].length) throw new Error('Unable to enforce the scoped OpenCode generation budget with native plugin overrides.');
  }
  const providers = openCodeRecord(base['provider']);
  const provider = openCodeRecord(providers[providerId]);
  const models = openCodeRecord(provider['models']);
  const config = openCodeRecord(models[modelId]);
  const limit = openCodeRecord(config['limit']);
  const options = openCodeRecord(config['options']);
  const effectiveModel = openCodeModelConfig(effectiveConfig ?? {}, model);
  const effectiveLimit = openCodeRecord(effectiveModel['limit']);
  const nativeVariants = openCodeRecord(effectiveModel['variants']);
  const overlayVariants = openCodeRecord(config['variants']);
  const variants = { ...nativeVariants, ...overlayVariants };
  const overlayAgents = openCodeRecord(base['agent']);
  const nativeAgents = openCodeRecord(effectiveConfig?.['agent']);
  // Scope comes from the native merged config: an overlay may omit an inherited model/mode.
  const resolvedAgents = Object.fromEntries([...new Set([...Object.keys(overlayAgents), ...Object.keys(nativeAgents)])].map((name) => {
    const overlay = openCodeRecord(overlayAgents[name]);
    const native = openCodeRecord(nativeAgents[name]);
    return [name, { ...overlay, ...native, options: { ...openCodeRecord(overlay['options']), ...openCodeRecord(native['options']) } }];
  }));
  const agents = scopedAgents({ ...base, ...effectiveConfig, agent: resolvedAgents }, model);
  const agentCap = (agent: Record<string, unknown>) => capOf(Object.hasOwn(agent, 'max_completion_tokens') ? agent : openCodeRecord(agent['options']));
  const caps = [openCodePositive(limit['output']), capOf(options), openCodePositive(effectiveLimit['output']), capOf(openCodeRecord(effectiveModel['options'])),
    ...[nativeVariants, overlayVariants].flatMap((layer) => Object.values(layer).map((variant) => capOf(openCodeRecord(variant)))),
    ...agents.flatMap(([name]) => [agentCap(openCodeRecord(overlayAgents[name])), agentCap(openCodeRecord(nativeAgents[name]))])];
  const output = Math.min(16384, ...caps.filter((value): value is number => value !== undefined));
  // Official MiMo-V2.6 launch documentation publishes a 1M context window.
  // The compatible SDK sends max_tokens; MiMo documents the combined cap as max_completion_tokens.
  models[modelId] = { ...config, options: { ...options, max_completion_tokens: output },
    limit: { ...limit, context: openCodePositive(effectiveLimit['context']) ?? openCodePositive(limit['context']) ?? 1_000_000, output },
    ...(Object.keys(variants).length ? { variants: Object.fromEntries(Object.keys(variants).map((name) => [name, { ...openCodeRecord(openCodeRecord(config['variants'])[name]), max_completion_tokens: output }])) } : {}),
  };
  providers[providerId] = { ...provider, models };
  base['provider'] = providers;
  for (const [name, agent] of agents) {
    if (agentCap(agent) === undefined) continue;
    const overlay = openCodeRecord(overlayAgents[name]);
    overlayAgents[name] = { ...overlay, ...(Object.hasOwn(agent, 'max_completion_tokens') ? { max_completion_tokens: output } : {}), options: { ...openCodeRecord(overlay['options']), max_completion_tokens: output } };
  }
  if (Object.keys(overlayAgents).length) base['agent'] = overlayAgents;
  return { model, combinedOutputTokens: output, reasoningBudgetSupported: false };
}

export function assertOpenCodeGenerationBudget(effective: Record<string, unknown>, budget: OpenCodeGenerationBudget): void {
  const check: Record<string, unknown> = {};
  const resolved = applyOpenCodeGenerationBudget(check, budget.model, effective);
  const selected = openCodeModelConfig(effective, budget.model);
  if (resolved?.combinedOutputTokens !== budget.combinedOutputTokens
    || capOf(openCodeRecord(selected['options'])) !== budget.combinedOutputTokens
    || openCodePositive(openCodeRecord(selected['limit'])['output']) !== budget.combinedOutputTokens
    || Object.values(openCodeRecord(selected['variants'])).some((variant) => capOf(openCodeRecord(variant)) !== budget.combinedOutputTokens)
    || scopedAgents(effective, budget.model).some(([, agent]) => {
      const cap = capOf(Object.hasOwn(agent, 'max_completion_tokens') ? agent : openCodeRecord(agent['options']));
      return cap !== undefined && cap !== budget.combinedOutputTokens;
    })) throw new Error('Unable to verify the effective scoped OpenCode generation budget safely.');
}
