import type { OpenCodeNativeModelLimits } from './opencode-native-model-limits';
import { openCodeModelConfig, openCodePositive, openCodeRecord } from './opencode-config-shapes';

/** Provider-window ceiling policy. Zero leaves the provider default unchanged. */
function readSetting(key: string): unknown {
 try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getSettingsManager } = require('../../core/config/settings-manager') as { getSettingsManager: () => { get: (key: string) => unknown } };
  return getSettingsManager().get(key);
 } catch { return undefined; }
}
export function resolveContextCeilingTokens(machineSession: boolean, read: (key: string) => unknown = readSetting): number | undefined {
 const value = read(machineSession ? 'machineContextCeilingTokens' : 'ownChatContextCeilingTokens');
 if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
 return Math.min(1_000_000, Math.max(100_000, Math.floor(value)));
}
export function selfCompactThreshold(modelWindow: number, ceiling?: number): number {
 return Math.max(0, Math.min(modelWindow, ceiling ?? modelWindow) - 33_000);
}
/** True when the ceiling has a model and a positive budget to apply. */
export function contextCeilingApplies(model: string | undefined, ceilingTokens: number | undefined): boolean {
 return Boolean(model && model.indexOf('/') > 0
  && typeof ceilingTokens === 'number' && Number.isFinite(ceilingTokens) && ceilingTokens > 0);
}
/** What the ceiling did: `skipped` means it wanted to apply but no valid override could be emitted. */
export type OpenCodeContextCeilingOutcome = 'unchanged' | 'applied' | 'skipped';
const positive = (value: unknown): number | undefined =>
 typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : undefined;
/**
 * OpenCode's context-ceiling lever: `limit.context` is the window OpenCode
 * manages to, so clamping it down makes long sessions compact earlier the way
 * `CLAUDE_CODE_AUTO_COMPACT_WINDOW` does for Claude (October follow-ups A#61,
 * previously unplaced because `limit.context` defaulted to the provider's own
 * 1,000,000). The model's window is resolved before clamping — from the native
 * model catalog (`nativeLimits`, the source of truth the configuration probe
 * does not carry: it returns overrides only), from the probe's effective
 * configuration, and from both overlay shapes (the OpenCode 1 `provider` tree
 * and the OpenCode 2 `providers` tree) — and the clamp only ever moves a window
 * down: the narrowest known window is used, so a native or 2.x limit can never
 * be raised to the ceiling. Every other limit field (such as `output`) is
 * retained, with catalog limits below every configured limit in precedence.
 *
 * OpenCode's schema requires both `limit.context` and `limit.output` whenever a
 * model entry carries a `limit`, so the override is emitted only when the
 * output cap resolves too; otherwise the config is left untouched (`skipped`)
 * rather than written in a shape OpenCode would reject outright. Never runs
 * without a configured ceiling.
 */
export function applyOpenCodeContextCeiling(base: Record<string, unknown>, model: string | undefined, ceilingTokens: number | undefined, effectiveConfig?: Record<string, unknown>, nativeLimits?: OpenCodeNativeModelLimits): OpenCodeContextCeilingOutcome {
 if (!model || typeof ceilingTokens !== 'number' || !Number.isFinite(ceilingTokens) || ceilingTokens <= 0) return 'unchanged';
 const slash = model.indexOf('/');
 if (slash <= 0) return 'unchanged';
 const providerId = model.slice(0, slash);
 const modelId = model.slice(slash + 1);
 const ceiling = Math.min(1_000_000, Math.floor(ceilingTokens));
 const shapes = (['provider', 'providers'] as const).map((key) => {
  const root = openCodeRecord(base[key]);
  const provider = openCodeRecord(root[providerId]);
  const models = openCodeRecord(provider['models']);
  const entry = models[modelId];
  const config = openCodeRecord(entry);
  return { key, root, provider, models, entry, config, limit: openCodeRecord(config['limit']) };
 });
 const effectiveLimit = openCodeRecord(openCodeModelConfig(effectiveConfig ?? {}, model)['limit']);
 const nativeLimit: Record<string, unknown> = { ...(nativeLimits ?? {}) };
 const known = [positive(nativeLimit['context']), openCodePositive(effectiveLimit['context']), ...shapes.map(({ limit }) => openCodePositive(limit['context']))]
  .filter((value): value is number => value !== undefined);
 const current = known.length ? Math.min(...known) : undefined;
 const next = current === undefined ? ceiling : Math.min(current, ceiling);
 const owned = shapes.filter(({ entry }) => entry !== undefined);
 const present = shapes.filter(({ root }) => Object.keys(root).length > 0);
 const targets = owned.length ? owned : present.length ? present : shapes.filter(({ key }) => key === 'provider');
 let applied = false;
 let blocked = false;
 for (const target of targets) {
  const previous = openCodePositive(target.limit['context']);
  if (next === previous && target.entry !== undefined) continue;
  // Precedence: catalog defaults below every configured limit (probe-effective
  // config, the other overlay shape, then the entry being written).
  const limit: Record<string, unknown> = {};
  for (const source of [nativeLimit, effectiveLimit,
   ...shapes.filter((shape) => shape.key !== target.key).map((shape) => shape.limit), target.limit]) {
   for (const [field, value] of Object.entries(source)) if (value !== undefined) limit[field] = value;
  }
  limit['context'] = next;
  // A `limit` without a positive `output` cap is invalid to OpenCode and would
  // refuse the session before ACP ever starts; leave the config alone instead.
  if (positive(limit['output']) === undefined || positive(next) === undefined) { blocked = true; continue; }
  target.models[modelId] = { ...target.config, limit };
  target.provider['models'] = target.models;
  target.root[providerId] = target.provider;
  base[target.key] = target.root;
  applied = true;
 }
 return applied ? 'applied' : blocked ? 'skipped' : 'unchanged';
}
