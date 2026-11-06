/**
 * Say what a runtime change will cost before it is made (Oct-2 T17).
 *
 * Runs the same diff and the same continuity rule the reconciler uses when the change is
 * applied, against the live session, and turns the result into one plain sentence. It changes
 * nothing: no session is touched, no state is written.
 */

import type { Instance, RuntimeChangeRequest } from '../../../shared/types/instance.types';
import { providerName } from '../../../shared/display-names';
import { isModelSwitchAllowedStatus } from '../../../shared/types/instance-status-policy';
import { getProviderModelContextWindow } from '../../../shared/types/provider.types';
import { resolveCacheLifetimeMs, trustedContextTokens } from '../../../shared/utils/claude-cache-economics';
import { describeRuntimeChangeCost, type RuntimeChangeCostNote } from '../../../shared/utils/runtime-change-cost';
import type { CliType } from '../../cli/cli-detection';
import { readAccountContinuation } from './account-continuation-policy';
import { computeRuntimeDiff, planRuntimeContinuity } from './runtime-reconciler-plan';
import type { RuntimeAdapterCapabilities } from './runtime-reconciler.types';

export interface RuntimeChangePreviewDeps {
  getInstance(instanceId: string): Instance | undefined;
  /** The live adapter, as the reconciler sees it (local or relayed from a worker). */
  getAdapter(instanceId: string): unknown;
  /** The cache lifetime the session's replies reported, or null before the first one. */
  getCacheLifetimeMs?(instanceId: string): number | null;
  now?(): number;
}

function capabilitiesOf(adapter: unknown): RuntimeAdapterCapabilities | null {
  const candidate = adapter as { getRuntimeCapabilities?: () => RuntimeAdapterCapabilities } | null | undefined;
  if (typeof candidate?.getRuntimeCapabilities !== 'function') return null;
  const { supportsResume, supportsForkSession } = candidate.getRuntimeCapabilities();
  return { supportsResume: supportsResume === true, supportsForkSession: supportsForkSession === true };
}

/** The sentence for `request` applied to the live session, or null when there is nothing to say. */
export function previewRuntimeChange(
  deps: RuntimeChangePreviewDeps,
  instanceId: string,
  request: RuntimeChangeRequest,
): RuntimeChangeCostNote | null {
  const instance = deps.getInstance(instanceId);
  if (!instance) return null;
  // A session with no live process (hibernated, ended) has nothing warm to lose.
  const capabilities = capabilitiesOf(deps.getAdapter(instanceId));
  if (!capabilities) return null;

  // The same normalisation `requestModelChange` applies: no provider means "stay on this one".
  const provider = request.provider === 'auto' ? undefined : request.provider;
  const desired = { ...request, provider: provider ?? instance.provider };
  const diff = computeRuntimeDiff(instance, desired);
  if (!diff.hasChanges) return null;

  const localModel = desired.modelRuntimeTarget?.kind === 'local-model';
  const continuity = planRuntimeContinuity({
    diff,
    capabilities,
    // Same gate as the reconciler: a turn the provider never stored cannot
    // natively resume, so the preview must not promise that it will.
    hasConversation: instance.outputBuffer.some((message) => message.type === 'user' || message.type === 'assistant')
      && instance.providerSessionPersisted !== false,
    // planContinuity only asks whether this is Claude.
    cliType: (desired.provider === 'auto' ? instance.provider : desired.provider) as CliType,
    isLocalModelTarget: localModel,
    // The same effective policy the reconciler applies when the handoff runs
    // (it is read where `applyAccountHandoff` reads it), so a pool configured
    // to replay says so before the click — including the context it discards.
    ...(diff.accountProfileChanged ? { accountContinuation: readAccountContinuation(instance.provider) } : {}),
  });

  const targetProvider = desired.provider === 'auto' ? instance.provider : desired.provider;
  const targetModel = localModel ? undefined : desired.model ?? instance.currentModel;
  const now = deps.now?.() ?? Date.now();
  // Only Claude's cache lifetime is measured; elsewhere the cache is assumed warm.
  const cacheWarm = instance.provider === 'claude'
    ? now - instance.lastActivity < resolveCacheLifetimeMs(deps.getCacheLifetimeMs?.(instanceId))
    : undefined;

  return describeRuntimeChangeCost(diff, trustedContextTokens(instance.contextUsage), isModelSwitchAllowedStatus(instance.status), {
    continuity,
    // A local model's window is not known here; the sentence then leaves the share out.
    targetWindowTokens: localModel ? null : getProviderModelContextWindow(targetProvider, targetModel),
    targetLabel: localModel ? 'the local model' : providerName(targetProvider),
    ...(cacheWarm === undefined ? {} : { cacheWarm }),
  });
}
