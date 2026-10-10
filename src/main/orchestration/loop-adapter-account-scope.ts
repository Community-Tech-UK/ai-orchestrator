import type { CliType } from '../cli/cli-detection';
import { getLoopAccountFailover } from '../providers/account-pool/loop-account-failover';
import { resolveAutomationDefaultModel } from './automation-model-defaults';

interface LoopAdapterInvocation {
  readonly provider: CliType;
  readonly model: string | undefined;
}

// Adapter lifetime owns construction authority; terminal cleanup need not retain run IDs.
const constructedInvocations = new WeakMap<object, LoopAdapterInvocation>();

export function rememberLoopAdapterInvocation(adapter: object, provider: CliType, model: string | undefined): void {
  constructedInvocations.set(adapter, Object.freeze({ provider, model }));
}

export function getLoopAdapterInvocation(adapter: unknown): LoopAdapterInvocation | undefined {
  return adapter !== null && typeof adapter === 'object' ? constructedInvocations.get(adapter) : undefined;
}

/** Compare the next request with the constructor's existing default fallback contract. */
export function canReuseLoopAdapter(
  loopRunId: string, adapter: unknown, provider: CliType, requestedModel: string | undefined,
  persistentModels: ReadonlyMap<string, string | undefined>,
): boolean {
  if (!persistentModels.has(loopRunId)) return false;
  const actual = getLoopAdapterInvocation(adapter);
  if (!actual) return persistentModels.get(loopRunId) === requestedModel;
  return actual.provider === provider && actual.model === (requestedModel ?? resolveAutomationDefaultModel(provider));
}

/** Record construction truth before any later invocation/settings resolution. */
export function noteLoopAdapterAccountScope(
  loopRunId: string,
  adapter: unknown,
  provider: string,
  resolvedModel: string | undefined,
  persistentModels?: ReadonlyMap<string, string | undefined>,
): void {
  const actual = getLoopAdapterInvocation(adapter);
  getLoopAccountFailover().noteIterationAdapter(loopRunId, adapter, actual ?? {
    provider,
    // Map.has preserves genuinely unknown construction when no metadata exists.
    model: persistentModels?.has(loopRunId) ? persistentModels.get(loopRunId) : resolvedModel,
  });
}
