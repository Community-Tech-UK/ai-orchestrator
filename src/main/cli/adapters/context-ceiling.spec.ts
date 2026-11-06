import { expect, it } from 'vitest';
import { applyOpenCodeContextCeiling, contextCeilingApplies, resolveContextCeilingTokens, selfCompactThreshold } from './context-ceiling';
import { serializeOpenCodeConfigForV2 } from './opencode-v2-config';
it('selects chat or machine settings, disabled by default and clamps enabled ceilings', () => {
 const read = (key: string) => key === 'machineContextCeilingTokens' ? 120_000 : 200_000;
 expect(resolveContextCeilingTokens(false, read)).toBe(200_000);
 expect(resolveContextCeilingTokens(true, read)).toBe(120_000);
 expect(resolveContextCeilingTokens(false, () => 0)).toBeUndefined();
 expect(resolveContextCeilingTokens(true, () => 1)).toBe(100_000);
 expect(resolveContextCeilingTokens(true, () => 2_000_000)).toBe(1_000_000);
 expect(selfCompactThreshold(1_000_000, 120_000)).toBe(87_000);
 expect(selfCompactThreshold(200_000)).toBe(167_000);
});
function limitOf(config: Record<string, unknown>): Record<string, unknown> {
 const provider = (config['provider'] ?? {}) as Record<string, unknown>;
 const models = ((provider['xiaomi-token-plan'] ?? provider['p'] ?? provider['openai'] ?? {}) as Record<string, unknown>)['models'] as Record<string, unknown>;
 const model = (models['mimo-v2.6-pro'] ?? models['m'] ?? models['gpt-4o']) as Record<string, unknown>;
 return model['limit'] as Record<string, unknown>;
}
it('clamps OpenCode limit.context down to the ceiling and never up (A#61)', () => {
 const config = (context: number | undefined) => ({
   provider: { 'xiaomi-token-plan': { models: { 'mimo-v2.6-pro': context === undefined ? {} : { limit: { context, output: 32_000 } } } } },
 });
 const clamped = config(1_000_000);
 expect(applyOpenCodeContextCeiling(clamped, 'xiaomi-token-plan/mimo-v2.6-pro', 250_000)).toBe('applied');
 expect(limitOf(clamped)).toEqual({ context: 250_000, output: 32_000 });

 const small = config(120_000);
 expect(applyOpenCodeContextCeiling(small, 'xiaomi-token-plan/mimo-v2.6-pro', 250_000)).toBe('unchanged');
 expect(limitOf(small)['context']).toBe(120_000);

 // A model entry without any limit gets the ceiling only when the catalog
 // (or config) resolves the `limit.output` key OpenCode's schema requires.
 const missing = config(undefined);
 expect(applyOpenCodeContextCeiling(missing, 'xiaomi-token-plan/mimo-v2.6-pro', 250_000,
   undefined, { context: 1_000_000, output: 32_000 })).toBe('applied');
 expect(limitOf(missing)).toEqual({ context: 250_000, output: 32_000 });
});
it('leaves OpenCode config untouched without a configured ceiling or model', () => {
 const config = { provider: { p: { models: { m: { limit: { context: 1_000_000, output: 100 } } } } } };
 expect(applyOpenCodeContextCeiling(config, 'p/m', undefined)).toBe('unchanged');
 expect(applyOpenCodeContextCeiling(config, 'p/m', 0)).toBe('unchanged');
 expect(applyOpenCodeContextCeiling(config, undefined, 250_000)).toBe('unchanged');
 expect(applyOpenCodeContextCeiling(config, 'p', 250_000)).toBe('unchanged');
 expect(limitOf(config)['context']).toBe(1_000_000);
 expect(contextCeilingApplies('p/m', 250_000)).toBe(true);
 expect(contextCeilingApplies('p/m', undefined)).toBe(false);
 expect(contextCeilingApplies(undefined, 250_000)).toBe(false);
});
it('clamps against the native effective window and never raises it (A#61)', () => {
 const effective = { provider: { p: { models: { m: { limit: { context: 120_000, output: 4096 } } } } } };
 const base = (): Record<string, unknown> => ({ provider: { p: { models: { m: {} } } } });

 const untouched = base();
 expect(applyOpenCodeContextCeiling(untouched, 'p/m', 250_000, effective)).toBe('applied');
 expect(limitOf(untouched)).toEqual({ context: 120_000, output: 4096 });

 const clamped = base();
 expect(applyOpenCodeContextCeiling(clamped, 'p/m', 100_000, effective)).toBe('applied');
 expect(limitOf(clamped)).toEqual({ context: 100_000, output: 4096 });

 const overlay = { provider: { p: { models: { m: { limit: { context: 1_000_000, output: 8192 } } } } } };
 expect(applyOpenCodeContextCeiling(overlay, 'p/m', 250_000, effective)).toBe('applied');
 // The narrowest known window wins: a native limit the overlay does not
 // record can never be raised to the ceiling.
 expect(limitOf(overlay)).toEqual({ context: 120_000, output: 8192 });

 const bare: Record<string, unknown> = { permission: { '*': 'allow' } };
 expect(applyOpenCodeContextCeiling(bare, 'p/m', 250_000, effective)).toBe('applied');
 expect(limitOf(bare)).toEqual({ context: 120_000, output: 4096 });
});
it('resolves the OpenCode 2 providers shape and keeps other limit fields through the serializer (A#61)', () => {
 const v2LimitOf = (config: Record<string, unknown>): Record<string, unknown> => {
  const providers = config['providers'] as Record<string, unknown>;
  const provider = providers['p'] as Record<string, unknown>;
  const models = provider['models'] as Record<string, unknown>;
  return (models['m'] as Record<string, unknown>)['limit'] as Record<string, unknown>;
 };
 const small = { providers: { p: { models: { m: { limit: { context: 120_000, output: 4096 } } } } } };
 expect(applyOpenCodeContextCeiling(small, 'p/m', 250_000)).toBe('unchanged');
 serializeOpenCodeConfigForV2(small);
 expect(v2LimitOf(small)).toEqual({ context: 120_000, output: 4096 });

 const clamped = { providers: { p: { models: { m: { limit: { context: 1_000_000, output: 4096 } } } } } };
 expect(applyOpenCodeContextCeiling(clamped, 'p/m', 250_000)).toBe('applied');
 serializeOpenCodeConfigForV2(clamped);
 expect(v2LimitOf(clamped)).toEqual({ context: 250_000, output: 4096 });
});
it('expresses the ceiling for a built-in model from the native catalog limits (verifier round 3)', () => {
 // The real probe path: a built-in model with no explicit override projects
 // no limit at all, while the catalog knows both keys (openai/gpt-4o reports
 // context 128000 and output 16384).
 const native = { context: 128_000, output: 16_384 };
 const base = (): Record<string, unknown> => ({ model: 'openai/gpt-4o' });

 const lower = base();
 expect(applyOpenCodeContextCeiling(lower, 'openai/gpt-4o', 100_000, undefined, native)).toBe('applied');
 expect(limitOf(lower)).toEqual({ context: 100_000, output: 16_384 });

 const wider = base();
 expect(applyOpenCodeContextCeiling(wider, 'openai/gpt-4o', 250_000, undefined, native)).toBe('applied');
 expect(limitOf(wider)).toEqual({ context: 128_000, output: 16_384 });

 // Catalog limits sit below every configured limit in precedence: the
 // overlay's output cap is kept and the real window still wins the clamp.
 const overlay = { provider: { openai: { models: { 'gpt-4o': { limit: { context: 1_000_000, output: 8192 } } } } } };
 expect(applyOpenCodeContextCeiling(overlay, 'openai/gpt-4o', 250_000, undefined, native)).toBe('applied');
 expect(limitOf(overlay)).toEqual({ context: 128_000, output: 8192 });
});
it('never emits a partial limit that OpenCode would reject (verifier round 3)', () => {
 // OpenCode's schema requires both limit.context and limit.output whenever a
 // limit exists: emitting context alone refuses every session with the config.
 const base = (): Record<string, unknown> => ({ model: 'openai/gpt-4o' });

 const noCatalog = base();
 expect(applyOpenCodeContextCeiling(noCatalog, 'openai/gpt-4o', 100_000)).toBe('skipped');
 expect(noCatalog).toEqual({ model: 'openai/gpt-4o' });

 const noOutput = base();
 expect(applyOpenCodeContextCeiling(noOutput, 'openai/gpt-4o', 100_000,
   { provider: { openai: { models: { 'gpt-4o': { limit: { context: 128_000, output: undefined }, options: { max_completion_tokens: undefined } } } } } },
   { context: 128_000 })).toBe('skipped');
 expect(noOutput).toEqual({ model: 'openai/gpt-4o' });

 const listedWithoutLimits = base();
 expect(applyOpenCodeContextCeiling(listedWithoutLimits, 'openai/gpt-4o', 100_000, undefined,
   { context: undefined, output: undefined })).toBe('skipped');
 expect(listedWithoutLimits).toEqual({ model: 'openai/gpt-4o' });
});
