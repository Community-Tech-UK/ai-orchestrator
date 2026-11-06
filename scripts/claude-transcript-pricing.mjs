/** Offline audit prices, pinned to the application's 2026-11-03 price table.
 * USD per million tokens. Native transcripts distinguish 5m/1h writes, unlike
 * the application's flat cacheWriteTokens counter. Never guess a future rate.
 */
export const TRANSCRIPT_PRICING_VERSION = '2026-11-03';
const legacy = (input, output, read = 0.1) => ({ input, output, read });
const models = {
  opus: legacy(4, 20, 0.05), 'opus[1m]': legacy(4, 20, 0.05),
  sonnet: legacy(2, 10, 0.05), 'sonnet[1m]': legacy(2, 10, 0.05), haiku: legacy(0.1, 0.5),
  'claude-opus-5-5': legacy(4, 20, 0.05), 'claude-sonnet-5-5': legacy(2, 10, 0.05),
  'claude-haiku-5-5': legacy(0.1, 0.5), 'claude-fable-5-1': legacy(10, 50, 0.025),
  'claude-fable-5': legacy(10, 50),
  'claude-opus-5': legacy(5, 25), 'claude-sonnet-5': legacy(2, 10),
  'claude-opus-4-8': legacy(5, 25), 'claude-opus-4-7': legacy(5, 25),
  'claude-opus-4-6': legacy(5, 25), 'claude-opus-4-5': legacy(5, 25),
  'claude-opus-4': legacy(15, 75), 'claude-3-opus': legacy(15, 75),
  'claude-sonnet-4-6': legacy(3, 15), 'claude-sonnet-4-5': legacy(3, 15),
  'claude-sonnet-4': legacy(3, 15), 'claude-3-5-sonnet': legacy(3, 15), 'claude-3-sonnet': legacy(3, 15),
  'claude-haiku-4-6': legacy(1, 5), 'claude-haiku-4-5': legacy(1, 5),
  'claude-3-5-haiku': legacy(0.8, 4), 'claude-3-haiku': legacy(0.25, 1.25),
};

export function transcriptRate(model, prices) {
  const version = model.replace(/-\d{8}$/, '');
  const known = Object.hasOwn(models, model) ? models[model] : Object.hasOwn(models, version) ? models[version] : undefined;
  const override = Object.hasOwn(prices, model) ? prices[model] : undefined;
  if (override !== undefined && (!override || typeof override !== 'object'
    || ![override.input, override.output].every(valid)
    || ['cacheRead', 'cacheWrite', 'cacheWrite1h'].some(key => override[key] !== undefined && !valid(override[key])))) {
    throw new Error(`Invalid price for ${model}`);
  }
  if (!known && !override) return undefined;
  // Base-only overrides retain this model version's cache ratios. Unknown
  // models need all cache rates explicitly; no family-name fallback is safe.
  if (!known && ['cacheRead', 'cacheWrite', 'cacheWrite1h'].some(key => override[key] === undefined)) {
    throw new Error(`Invalid price for ${model}: explicit cache rates required for an unknown model`);
  }
  const { input, output } = override ?? known;
  return { input, output, cacheRead: override?.cacheRead ?? input * known.read,
    cacheWrite: override?.cacheWrite ?? input * 1.25,
    cacheWrite1h: override?.cacheWrite1h ?? input * 2 };
}
function valid(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
